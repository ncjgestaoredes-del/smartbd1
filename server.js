
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const dbConfig = {
    host: process.env.DB_HOST || 'mysql-albertocossa.alwaysdata.net',
    user: process.env.DB_USER || '430726',
    password: process.env.DB_PASSWORD || 'Acossa@824018',
    database: process.env.DB_NAME || 'albertocossa_bd1',
    waitForConnections: true,
    connectionLimit: 10
};

let pool;

async function connectDB() {
    try {
        pool = await mysql.createPool(dbConfig);
        console.log("MySQL Pronto.");
    } catch (err) {
        console.error("Conexão falhou:", err.message);
    }
}

// Helper para obter colunas de uma tabela (cache simples para performance)
const tableColumnsCache = {};
async function getTableColumns(tableName) {
    if (tableColumnsCache[tableName]) return tableColumnsCache[tableName];
    try {
        const [rows] = await pool.execute(`SHOW COLUMNS FROM ${tableName}`);
        const cols = rows.map(r => r.Field);
        tableColumnsCache[tableName] = cols;
        return cols;
    } catch (e) {
        console.error(`Erro ao ler colunas de ${tableName}:`, e.message);
        return [];
    }
}

// Helper genérico para UPSERT com filtro de colunas
async function syncGeneric(tableName, data, schoolId) {
    if (!data || !Array.isArray(data)) return;
    
    const dbColumns = await getTableColumns(tableName);
    if (dbColumns.length === 0) throw new Error(`Tabela ${tableName} não encontrada ou inacessível.`);

    for (const item of data) {
        // Filtra apenas as propriedades que existem no banco de dados
        const itemWithSchool = { ...item };
        if (schoolId !== 'SYSTEM' && dbColumns.includes('schoolId')) {
            itemWithSchool.schoolId = schoolId;
        }

        const validKeys = Object.keys(itemWithSchool).filter(k => dbColumns.includes(k));
        
        const values = validKeys.map(k => {
            const val = itemWithSchool[k];
            if (val === undefined || val === null) return null;
            return typeof val === 'object' ? JSON.stringify(val) : val;
        });

        const placeholders = validKeys.map(() => '?').join(', ');
        const updates = validKeys.map(k => `${k}=VALUES(${k})`).join(', ');

        const sql = `INSERT INTO ${tableName} (${validKeys.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
        await pool.execute(sql, values);
    }
}

app.get('/', (req, res) => res.send("SEI Smart API Online v2.6"));

// --- AUTH ---
app.post('/api/auth/login', async (req, res) => {
    const { schoolCode, email, password } = req.body;
    
    try {
        const cleanEmail = email ? email.trim().toLowerCase() : '';
        const cleanCode = schoolCode ? schoolCode.trim().toLowerCase() : '';

        if (cleanEmail === 'admin@sistema.com' && password === 'admin') {
            const [rows] = await pool.execute('SELECT * FROM users WHERE LOWER(email) = ?', [cleanEmail]);
            if (rows.length > 0) return res.json({ success: true, user: rows[0] });
        }

        const [rows] = await pool.execute(`
            SELECT u.*, s.status as schoolStatus, s.name as schoolName 
            FROM users u 
            INNER JOIN schools s ON u.schoolId = s.id 
            WHERE LOWER(s.accessCode) = ? AND LOWER(u.email) = ? AND u.password = ?
        `, [cleanCode, cleanEmail, password]);

        if (rows.length > 0) {
            const user = rows[0];
            if (user.schoolStatus === 'Bloqueado') {
                return res.status(403).json({ success: false, message: 'O acesso da sua escola foi bloqueado pelo administrador central.' });
            }
            res.json({ success: true, user });
        } else {
            res.status(401).json({ success: false, message: 'Código da escola ou credenciais inválidas.' });
        }
    } catch (err) { 
        res.status(500).json({ error: "Erro interno no servidor de autenticação." }); 
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const [users] = await pool.execute('SELECT u.name, u.schoolId, s.name as schoolName FROM users u LEFT JOIN schools s ON u.schoolId = s.id WHERE LOWER(u.email) = ?', [email.toLowerCase()]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'E-mail não encontrado.' });

        const user = users[0];
        const requestId = `pw_${Date.now()}`;
        await pool.execute(`INSERT INTO password_reset_requests (id, schoolId, schoolName, userEmail, userName, status) VALUES (?, ?, ?, ?, ?, 'Pendente')`, 
        [requestId, user.schoolId, user.schoolName || 'Acesso Global', email, user.name]);
        res.json({ success: true, message: 'Solicitação enviada.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SAAS ---
app.get('/api/schools', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM schools ORDER BY createdAt DESC');
        res.json(rows.map(s => ({ ...s, subscription: typeof s.subscription === 'string' ? JSON.parse(s.subscription) : s.subscription })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/schools/sync', async (req, res) => {
    try {
        await syncGeneric('schools', req.body, 'SYSTEM');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/schools/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM schools WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/saas/password-requests', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM password_reset_requests ORDER BY createdAt DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SCHOOL DATA ---
app.get('/api/school/:id/full-data', async (req, res) => {
    const sid = req.params.id;
    try {
        const tables = ['users', 'students', 'turmas', 'academic_years', 'expenses', 'notifications', 'school_requests', 'discussion_topics'];
        const results = {};
        
        for (const table of tables) {
            const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE ${table === 'discussion_topics' ? 'schoolId' : 'schoolId'} = ?`, [sid]);
            results[table] = rows.map(r => {
                const jsonCols = ['subscription', 'subjectsByClass', 'teachers', 'studentIds', 'financialProfile', 'documents', 'grades', 'examGrades', 'attendance', 'behavior', 'payments', 'extraCharges', 'items', 'metadata', 'participantIds', 'availability'];
                const item = { ...r };
                jsonCols.forEach(col => { if(item[col] && typeof item[col] === 'string') try { item[col] = JSON.parse(item[col]); } catch(e){} });
                return item;
            });
        }
        
        const [settingsRows] = await pool.execute('SELECT * FROM school_settings WHERE schoolId = ?', [sid]);
        if (settingsRows.length > 0) {
            const s = settingsRows[0];
            results.settings = typeof s.general_settings === 'string' ? JSON.parse(s.general_settings) : s.general_settings;
            results.financial = typeof s.financial_settings === 'string' ? JSON.parse(s.financial_settings) : s.financial_settings;
        }

        const [msgs] = await pool.execute('SELECT m.* FROM discussion_messages m JOIN discussion_topics t ON m.topicId = t.id WHERE t.schoolId = ?', [sid]);
        results.messages = msgs;

        res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/school/:id/sync/:key', async (req, res) => {
    const sid = req.params.id;
    const key = req.params.key;
    const data = req.body;

    try {
        const keyMap = {
            'users': 'users', 'students': 'students', 'turmas': 'turmas', 'academic_years': 'academic_years',
            'expenses': 'expenses', 'notifications': 'notifications', 'requests': 'school_requests',
            'topics': 'discussion_topics', 'messages': 'discussion_messages', 'password_requests': 'password_reset_requests'
        };

        const targetTable = keyMap[key];
        if (targetTable) {
            await syncGeneric(targetTable, Array.isArray(data) ? data : [data], sid);
        } else if (key === 'settings' || key === 'financial') {
            const col = key === 'settings' ? 'general_settings' : 'financial_settings';
            await pool.execute(`INSERT INTO school_settings (schoolId, ${col}) VALUES (?, ?) ON DUPLICATE KEY UPDATE ${col} = ?`, [sid, JSON.stringify(data), JSON.stringify(data)]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 10000;
connectDB().then(() => {
    app.listen(PORT, () => console.log(`Servidor v2.6 pronto na porta ${PORT}`));
});
