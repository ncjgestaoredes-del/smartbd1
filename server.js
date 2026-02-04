
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Configuração do Banco de Dados (Use variáveis de ambiente no Render)
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false } // Geralmente necessário para provedores cloud
};

let pool;

async function connectDB() {
    try {
        pool = mysql.createPool(dbConfig);
        console.log('✅ MySQL Connected');
    } catch (err) {
        console.error('❌ DB Connection Error:', err);
    }
}

connectDB();

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);
        if (users.length === 0) return res.status(401).json({ message: 'Credenciais inválidas' });

        const user = users[0];
        let school = null;

        if (user.school_id) {
            const [schools] = await pool.execute('SELECT * FROM schools WHERE id = ?', [user.school_id]);
            school = schools[0];
        }

        res.json({ user, school });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// --- ROTAS SAAS (SUPER ADMIN) ---

app.get('/api/schools', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM schools');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/schools', async (req, res) => {
    const s = req.body;
    try {
        await pool.execute(
            'INSERT INTO schools (id, name, representative_name, email, contact, status, monthly_fee, next_due_date) VALUES (?,?,?,?,?,?,?,?)',
            [s.id, s.name, s.representativeName, s.email, s.contact, s.status, s.subscription.monthlyFee, s.subscription.nextDueDate]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// --- ROTAS DE RECURSOS ESCOLARES (DINÂMICAS) ---

// Mapeamento de tabelas por recurso
const tableMap = {
    'users': 'users',
    'students': 'students',
    'turmas': 'turmas',
    'expenses': 'expenses',
    'requests': 'system_requests',
    'topics': 'chat_topics',
    'messages': 'chat_messages',
    'notifications': 'notifications'
};

// GET genérico para recursos
app.get('/api/schools/:schoolId/:resource', async (req, res) => {
    const { schoolId, resource } = req.params;
    const table = tableMap[resource];

    try {
        if (!table) {
            // Se não tem tabela específica, buscamos na school_resources (JSON)
            const [rows] = await pool.execute('SELECT data FROM school_resources WHERE school_id = ? AND resource_key = ?', [schoolId, resource]);
            return res.json(rows[0]?.data || null);
        }

        // Se for uma tabela de entidade (students, turmas, etc)
        const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE school_id = ?`, [schoolId]);
        
        // Se a coluna for 'data' (JSON), mapeamos para retornar o array de objetos
        if (rows.length > 0 && rows[0].data) {
            return res.json(rows.map(r => typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
        }
        
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST genérico (Save/Update)
app.post('/api/schools/:schoolId/:resource', async (req, res) => {
    const { schoolId, resource } = req.params;
    const data = req.body;
    const table = tableMap[resource];

    try {
        if (!table) {
            await pool.execute(
                'INSERT INTO school_resources (school_id, resource_key, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = ?',
                [schoolId, resource, JSON.stringify(data), JSON.stringify(data)]
            );
        } else {
            // Se for um array de objetos (como students ou users vindo do syncResource do frontend)
            if (Array.isArray(data)) {
                // No MySQL real você faria um batch insert ou upsert. 
                // Para manter a simplicidade com a lógica atual do frontend:
                for (const item of data) {
                    if (table === 'users') {
                        await pool.execute(
                            'INSERT INTO users (id, school_id, name, email, password, role, avatar_url, contact) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=?, email=?, role=?, contact=?',
                            [item.id, schoolId, item.name, item.email, item.password || '123456', item.role, item.avatarUrl, item.contact, item.name, item.email, item.role, item.contact]
                        );
                    } else {
                        await pool.execute(
                            `INSERT INTO ${table} (id, school_id, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = ?`,
                            [item.id, schoolId, JSON.stringify(item), JSON.stringify(item)]
                        );
                    }
                }
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// DELETE genérico
app.delete('/api/schools/:schoolId/:resource/:id', async (req, res) => {
    const { resource, id } = req.params;
    const table = tableMap[resource];
    try {
        if (table) {
            await pool.execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
            res.json({ success: true });
        } else {
            res.status(400).json({ message: 'Recurso não deletável individualmente' });
        }
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
