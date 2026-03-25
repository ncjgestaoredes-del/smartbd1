const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

process.env.TZ = 'Africa/Maputo';

const app = express();

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

/* ================= DATABASE ================= */

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    timezone: '+02:00'
};

let pool;

async function connectDB() {
    try {

        pool = mysql.createPool(dbConfig);

        await pool.query("SET time_zone = '+02:00'");

        console.log("✅ MySQL conectado (CAT Moçambique)");

    } catch (err) {

        console.error("❌ Erro MySQL:", err.message);

    }
}

/* ================= CACHE COLUNAS ================= */

const tableColumnsCache = {};

async function getTableColumns(tableName) {

    if (tableColumnsCache[tableName]) {
        return tableColumnsCache[tableName];
    }

    const [rows] = await pool.execute(`SHOW COLUMNS FROM ${tableName}`);

    const cols = rows.map(r => r.Field);

    tableColumnsCache[tableName] = cols;

    return cols;
}

/* ================= SYNC GENERICO ================= */

async function syncGeneric(tableName, data, schoolId) {

    if (!Array.isArray(data)) return;

    const dbColumns = await getTableColumns(tableName);

    for (const item of data) {

        const row = { ...item };

        if (schoolId !== 'SYSTEM' && dbColumns.includes('schoolId')) {
            row.schoolId = schoolId;
        }

        const keys = Object.keys(row).filter(k => dbColumns.includes(k));

        const values = keys.map(k => {

            const val = row[k];

            if (val === null || val === undefined) return null;

            if (typeof val === "object") return JSON.stringify(val);

            return val;

        });

        const escaped = keys.map(k => `\`${k}\``);

        const placeholders = keys.map(() => "?").join(",");

        const updates = keys.map(k => `\`${k}\`=VALUES(\`${k}\`)`).join(",");

        const sql = `
        INSERT INTO ${tableName} (${escaped.join(",")})
        VALUES (${placeholders})
        ON DUPLICATE KEY UPDATE ${updates}
        `;

        await pool.execute(sql, values);
    }
}

/* ================= ROTAS ================= */

app.get('/', (req, res) => {

    res.send("SEI Smart API Online v2.9 - Moçambique");

});

/* LOGIN */

app.post('/api/auth/login', async (req, res) => {

    try {

        const { schoolCode, email, password } = req.body;

        const cleanEmail = email.trim().toLowerCase();
        const cleanCode = schoolCode.trim().toLowerCase();

        const [rows] = await pool.execute(`
        SELECT u.*, s.status as schoolStatus
        FROM users u
        INNER JOIN schools s ON u.schoolId = s.id
        WHERE LOWER(s.accessCode)=? AND LOWER(u.email)=? AND u.password=?
        `, [cleanCode, cleanEmail, password]);

        if (rows.length === 0) {

            return res.status(401).json({
                success:false,
                message:"Credenciais inválidas"
            });

        }

        const user = rows[0];

        if (user.schoolStatus === "Bloqueado") {

            return res.status(403).json({
                success:false,
                message:"Escola bloqueada"
            });

        }

        res.json({
            success:true,
            user
        });

    } catch (err) {

        res.status(500).json({ error: err.message });

    }

});

/* LISTAR ESCOLAS */

app.get('/api/schools', async (req,res)=>{

    try{

        const [rows] = await pool.execute(
            "SELECT * FROM schools ORDER BY createdAt DESC"
        );

        res.json(rows);

    }catch(err){

        res.status(500).json({error:err.message});

    }

});

/* DELETE ESCOLA */

app.delete('/api/schools/:id', async (req,res)=>{

    try{

        await pool.execute(
            "DELETE FROM schools WHERE id=?",
            [req.params.id]
        );

        res.json({success:true});

    }catch(err){

        res.status(500).json({error:err.message});

    }

});

/* SYNC */

app.post('/api/schools/sync', async (req,res)=>{

    try{

        await syncGeneric("schools",req.body,"SYSTEM");

        res.json({success:true});

    }catch(err){

        res.status(500).json({error:err.message});

    }

});

/* ================= FRONTEND ================= */

/* Servir React */

app.use(express.static(path.join(__dirname,'dist')));

/* Catch ALL - sem erro */

app.use((req,res)=>{

    res.sendFile(path.join(__dirname,'dist','index.html'));

});

/* ================= START SERVER ================= */

const PORT = process.env.PORT || 10000;

connectDB().then(()=>{

    app.listen(PORT,()=>{

        console.log(`🚀 Servidor rodando porta ${PORT}`);

    });

});
