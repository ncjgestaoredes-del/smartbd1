
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Configuração do Banco de Dados
const dbConfig = {
    host: 'seu-host-mysql.com',
    user: 'usuario',
    password: 'senha-segura',
    database: 'sei_smart_db'
};

let pool;

async function connectDB() {
    pool = await mysql.createPool(dbConfig);
    console.log("Conectado ao MySQL Online!");
}

// Rota de Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        // Busca em usuários globais e de escolas
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);
        if (rows.length > 0) {
            res.json({ success: true, user: rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'Usuário ou senha incorretos' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Busca todos os dados de uma escola
app.get('/api/school/:id/full-data', async (req, res) => {
    const schoolId = req.params.id;
    try {
        // Em um cenário real, cada entidade seria uma tabela.
        // Aqui simulamos buscando de um JSON estruturado ou tabelas separadas.
        const [rows] = await pool.execute('SELECT data_key, data_value FROM school_data WHERE school_id = ?', [schoolId]);
        const result = {};
        rows.forEach(row => {
            result[row.data_key] = JSON.parse(row.data_value);
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Sincronização de dados (Salvamento)
app.post('/api/school/:id/sync/:key', async (req, res) => {
    const schoolId = req.params.id;
    const key = req.params.key;
    const value = JSON.stringify(req.body);
    try {
        await pool.execute(
            'INSERT INTO school_data (school_id, data_key, data_value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data_value = ?',
            [schoolId, key, value, value]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/schools', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM schools');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = 3001;
connectDB().then(() => {
    app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
});
