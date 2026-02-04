
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const dbConfig = {
    host: process.env.DB_HOST ,
    user: process.env.DB_USER ,
    password: process.env.DB_PASSWORD ',
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
};

let pool;

async function connectDB() {
    try {
        pool = await mysql.createPool(dbConfig);
        console.log("Conectado ao MySQL com sucesso!");
    } catch (err) {
        console.error("Erro ao conectar:", err.message);
    }
}

// Helper para gerar queries de sincronização em massa (UPSERT)
async function syncCollection(tableName, data, schoolId) {
    if (!data || !Array.isArray(data)) return;
    
    for (const item of data) {
        const columns = Object.keys(item).filter(k => k !== 'schoolId');
        const values = columns.map(k => typeof item[k] === 'object' ? JSON.stringify(item[k]) : item[k]);
        
        const placeholders = columns.map(() => '?').join(', ');
        const updateClause = columns.map(k => `${k}=VALUES(${k})`).join(', ');

        const sql = `INSERT INTO ${tableName} (schoolId, ${columns.join(', ')}) 
                     VALUES (?, ${placeholders}) 
                     ON DUPLICATE KEY UPDATE ${updateClause}`;
        
        await pool.execute(sql, [schoolId, ...values]);
    }
}

app.get('/', (req, res) => res.send("API SEI Smart v2.0 Online"));

// --- AUTENTICAÇÃO ---
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await pool.execute(`
            SELECT u.*, s.status as schoolStatus, s.name as schoolName 
            FROM users u 
            LEFT JOIN schools s ON u.schoolId = s.id 
            WHERE u.email = ? AND u.password = ?
        `, [email, password]);

        if (rows.length > 0) {
            const user = rows[0];
            if (user.role !== 'SuperAdmin' && user.schoolStatus === 'Bloqueado') {
                return res.status(403).json({ success: false, message: 'Escola Bloqueada.' });
            }
            res.json({ success: true, user });
        } else {
            res.status(401).json({ success: false, message: 'Credenciais inválidas.' });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ROTAS DE ESCOLA (DADOS COMPLETOS) ---
app.get('/api/school/:id/full-data', async (req, res) => {
    const sid = req.params.id;
    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE schoolId = ?', [sid]);
        const [students] = await pool.execute('SELECT * FROM students WHERE schoolId = ?', [sid]);
        const [payments] = await pool.execute('SELECT * FROM payments WHERE schoolId = ?', [sid]);
        const [expenses] = await pool.execute('SELECT * FROM expenses WHERE schoolId = ?', [sid]);
        const [turmas] = await pool.execute('SELECT * FROM turmas WHERE schoolId = ?', [sid]);
        const [academic_years] = await pool.execute('SELECT * FROM academic_years WHERE schoolId = ?', [sid]);
        const [settings] = await pool.execute('SELECT * FROM school_settings WHERE school_id = ?', [sid]);

        res.json({
            users,
            students: students.map(s => ({ 
                ...s, 
                financialProfile: JSON.parse(s.financialProfile || '{}'),
                documents: JSON.parse(s.documents || '{}'),
                grades: JSON.parse(s.grades || '[]'),
                attendance: JSON.parse(s.attendance || '[]'),
                behavior: JSON.parse(s.behavior || '[]'),
                payments: payments.filter(p => p.studentId === s.id).map(p => ({ ...p, items: JSON.parse(p.items || '[]') }))
            })),
            turmas: turmas.map(t => ({ ...t, teachers: JSON.parse(t.teachers || '[]'), studentIds: JSON.parse(t.studentIds || '[]') })),
            expenses,
            academic_years: academic_years.map(ay => ({ ...ay, subjectsByClass: JSON.parse(ay.subjectsByClass || '[]') })),
            settings: settings[0] ? JSON.parse(settings[0].general_settings || '{}') : null,
            financial: settings[0] ? JSON.parse(settings[0].financial_settings || '{}') : null
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ROTAS DE SINCRONIZAÇÃO ESPECÍFICA ---

app.post('/api/school/:id/sync/:key', async (req, res) => {
    const sid = req.params.id;
    const key = req.params.key;
    const data = req.body;

    try {
        if (key === 'students') {
            for (const s of data) {
                await pool.execute(`
                    INSERT INTO students 
                    (id, schoolId, name, gender, birthDate, profilePictureUrl, guardianName, guardianContact, desiredClass, status, matriculationDate, financialProfile, documents, grades, attendance, behavior)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE 
                    name=?, gender=?, birthDate=?, profilePictureUrl=?, guardianName=?, guardianContact=?, desiredClass=?, status=?, matriculationDate=?, financialProfile=?, documents=?, grades=?, attendance=?, behavior=?
                `, [
                    s.id, sid, s.name, s.gender, s.birthDate, s.profilePictureUrl, s.guardianName, s.guardianContact, s.desiredClass, s.status, s.matriculationDate, 
                    JSON.stringify(s.financialProfile), JSON.stringify(s.documents), JSON.stringify(s.grades), JSON.stringify(s.attendance), JSON.stringify(s.behavior),
                    s.name, s.gender, s.birthDate, s.profilePictureUrl, s.guardianName, s.guardianContact, s.desiredClass, s.status, s.matriculationDate, 
                    JSON.stringify(s.financialProfile), JSON.stringify(s.documents), JSON.stringify(s.grades), JSON.stringify(s.attendance), JSON.stringify(s.behavior)
                ]);

                // Se houver pagamentos embutidos no objeto student do frontend, salvamos na tabela de pagamentos
                if (s.payments && Array.isArray(s.payments)) {
                    for (const p of s.payments) {
                        await pool.execute(`
                            INSERT INTO payments (id, schoolId, studentId, amount, type, method, academicYear, referenceMonth, date, description, items, operatorName)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON DUPLICATE KEY UPDATE amount=?, type=?, method=?, academicYear=?, referenceMonth=?, date=?, description=?, items=?, operatorName=?
                        `, [
                            p.id, sid, s.id, p.amount, p.type, p.method, p.academicYear, p.referenceMonth, p.date, p.description, JSON.stringify(p.items), p.operatorName,
                            p.amount, p.type, p.method, p.academicYear, p.referenceMonth, p.date, p.description, JSON.stringify(p.items), p.operatorName
                        ]);
                    }
                }
            }
        } 
        else if (key === 'users') {
            await syncCollection('users', data, sid);
        }
        else if (key === 'expenses') {
            await syncCollection('expenses', data, sid);
        }
        else if (key === 'turmas') {
            await syncCollection('turmas', data, sid);
        }
        else if (key === 'academic_years') {
            await syncCollection('academic_years', data, sid);
        }
        else if (key === 'settings' || key === 'financial') {
            const col = key === 'settings' ? 'general_settings' : 'financial_settings';
            await pool.execute(`
                INSERT INTO school_settings (school_id, ${col}) VALUES (?, ?)
                ON DUPLICATE KEY UPDATE ${col} = ?
            `, [sid, JSON.stringify(data), JSON.stringify(data)]);
        }

        res.json({ success: true });
    } catch (err) { 
        console.error("Sync Error:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// --- SUPER ADMIN: GESTÃO DE ESCOLAS ---
app.get('/api/schools', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM schools');
        res.json(rows.map(s => ({ ...s, subscription: typeof s.subscription === 'string' ? JSON.parse(s.subscription) : s.subscription })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/schools/sync', async (req, res) => {
    try {
        for (const s of req.body) {
            await pool.execute(`
                INSERT INTO schools (id, name, representativeName, email, contact, status, subscription)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE name=?, representativeName=?, email=?, contact=?, status=?, subscription=?
            `, [s.id, s.name, s.representativeName, s.email, s.contact, s.status, JSON.stringify(s.subscription),
                s.name, s.representativeName, s.email, s.contact, s.status, JSON.stringify(s.subscription)]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 10000;
connectDB().then(() => {
    app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
});
