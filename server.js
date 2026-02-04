
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Configurações de Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Configuração do Banco de Dados (Sempre priorizando Variáveis de Ambiente)
// No Render, você deve configurar estas variáveis no painel "Environment"
const dbConfig = {
    host: process.env.DB_HOST || 'mysql-albertocossa.alwaysdata.net',
    user: process.env.DB_USER || '430726',
    password: process.env.DB_PASSWORD || 'Acossa@824018',
    database: process.env.DB_NAME || 'albertocossa_bd1',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;

async function connectDB() {
    try {
        pool = await mysql.createPool(dbConfig);
        console.log("Conectado ao MySQL Online com sucesso!");
        
        // Teste de conexão
        const [rows] = await pool.execute('SELECT 1 + 1 AS solution');
        console.log('Teste de consulta DB:', rows[0].solution === 2 ? 'OK' : 'FALHA');
    } catch (err) {
        console.error("ERRO CRÍTICO ao conectar ao MySQL:", err.message);
        // Não encerra o processo imediatamente no Render para permitir debug
    }
}

// --- ROTAS DE SAÚDE DO SISTEMA ---
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'online', 
        db_connected: !!pool,
        timestamp: new Date().toISOString() 
    });
});

// --- ROTAS DE AUTENTICAÇÃO ---

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
                return res.status(403).json({ success: false, message: 'O acesso para esta escola está bloqueado. Contacte o suporte.' });
            }
            res.json({ success: true, user: user });
        } else {
            res.status(401).json({ success: false, message: 'E-mail ou senha incorretos' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const [users] = await pool.execute('SELECT u.*, s.name as schoolName FROM users u JOIN schools s ON u.schoolId = s.id WHERE u.email = ?', [email]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'Utilizador não encontrado.' });

        const user = users[0];
        const requestId = `reset_${Date.now()}`;
        const requestData = { id: requestId, schoolId: user.schoolId, schoolName: user.schoolName, userEmail: user.email, userName: user.name, status: 'Pendente', createdAt: new Date().toISOString() };

        const [current] = await pool.execute('SELECT data_value FROM school_data WHERE school_id = "SYSTEM" AND data_key = "password_requests"');
        let requests = current.length > 0 ? JSON.parse(current[0].data_value) : [];
        requests.push(requestData);

        await pool.execute(
            'INSERT INTO school_data (school_id, data_key, data_value) VALUES ("SYSTEM", "password_requests", ?) ON DUPLICATE KEY UPDATE data_value = ?',
            [JSON.stringify(requests), JSON.stringify(requests)]
        );
        res.json({ success: true, message: 'Solicitação enviada ao suporte central.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ROTAS DO SUPER ADMIN ---

app.get('/api/schools', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM schools ORDER BY createdAt DESC');
        const schools = rows.map(s => ({ ...s, subscription: typeof s.subscription === 'string' ? JSON.parse(s.subscription) : s.subscription }));
        res.json(schools);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/schools/sync', async (req, res) => {
    const schools = req.body;
    try {
        for (const school of schools) {
            await pool.execute(
                'INSERT INTO schools (id, name, representativeName, email, contact, status, subscription) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, representativeName=?, email=?, contact=?, status=?, subscription=?',
                [
                    school.id, school.name, school.representativeName, school.email, school.contact, school.status, JSON.stringify(school.subscription),
                    school.name, school.representativeName, school.email, school.contact, school.status, JSON.stringify(school.subscription)
                ]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/saas/password-requests', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT data_value FROM school_data WHERE school_id = "SYSTEM" AND data_key = "password_requests"');
        res.json(rows.length > 0 ? JSON.parse(rows[0].data_value) : []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ROTAS DE DADOS DA ESCOLA (TENANT) ---

app.get('/api/school/:id/full-data', async (req, res) => {
    const schoolId = req.params.id;
    try {
        const [rows] = await pool.execute('SELECT data_key, data_value FROM school_data WHERE school_id = ?', [schoolId]);
        const result = {};
        rows.forEach(row => {
            try { result[row.data_key] = JSON.parse(row.data_value); } catch (e) { result[row.data_key] = row.data_value; }
        });
        if (!result.users) {
            const [users] = await pool.execute('SELECT * FROM users WHERE schoolId = ?', [schoolId]);
            result.users = users;
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/school/:id/sync/:key', async (req, res) => {
    const schoolId = req.params.id;
    const key = req.params.key;
    const data = req.body;
    const value = JSON.stringify(data);
    try {
        if (key === 'users') {
            for (const user of data) {
                await pool.execute(
                    `INSERT INTO users (id, schoolId, name, email, password, role, avatarUrl, contact) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, email=?, password=?, role=?, avatarUrl=?, contact=?`,
                    [user.id, schoolId, user.name, user.email, user.password, user.role, user.avatarUrl, user.contact, user.name, user.email, user.password, user.role, user.avatarUrl, user.contact]
                );
            }
        }
        await pool.execute('INSERT INTO school_data (school_id, data_key, data_value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data_value = ?', [schoolId, key, value, value]);
        res.json({ success: true, key: key });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Inicialização
const PORT = process.env.PORT || 3001;
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Servidor SEI Smart rodando na porta ${PORT}`);
    });
});
