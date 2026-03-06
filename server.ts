
import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import dotenv from 'dotenv';
// import { createServer as createViteServer } from 'vite'; // Removed top-level import
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// FORÇAR FUSO HORÁRIO DE MOÇAMBIQUE NO PROCESSO NODE
process.env.TZ = 'Africa/Maputo';

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const dbConfig: mysql.PoolOptions = {
    host: process.env.DB_HOST || 'mysql-albertocossa.alwaysdata.net',
    user: process.env.DB_USER || '430726',
    password: process.env.DB_PASSWORD || 'Acossa@824018',
    database: process.env.DB_NAME || 'albertocossa_bd1',
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    // FORÇAR FUSO HORÁRIO NA CONEXÃO MYSQL
    timezone: '+02:00',
    // Adicionar SSL para conexões com bancos de dados em nuvem (como AlwaysData/Aiven)
    ssl: {
        rejectUnauthorized: false
    }
};

let pool: mysql.Pool;

async function connectDB() {
    try {
        console.log(`Tentando conectar ao MySQL em: ${dbConfig.host}...`);
        pool = await mysql.createPool(dbConfig);
        
        // Testar a conexão imediatamente
        const [test]: any = await pool.query("SELECT 1");
        console.log("Teste de conexão SELECT 1: OK");

        // Garantir que a sessão atual do MySQL use o fuso de Moçambique
        await pool.query("SET time_zone = '+02:00'");
        console.log("Conexão MySQL estabelecida em CAT (UTC+2) - Moçambique.");

        // Garantir que a coluna 'schedule' existe na tabela 'turmas'
        try {
            const [cols]: any = await pool.execute("SHOW COLUMNS FROM turmas LIKE 'schedule'");
            if (cols.length === 0) {
                await pool.execute("ALTER TABLE turmas ADD COLUMN schedule LONGTEXT");
                console.log("Coluna 'schedule' adicionada à tabela 'turmas'.");
            }
        } catch (e: any) {
            console.error("Erro ao verificar/adicionar coluna 'schedule':", e.message);
        }
    } catch (err: any) {
        console.error("Falha crítica na conexão com o Banco de Dados:", err.message);
    }
}

const tableColumnsCache: Record<string, string[]> = {};
async function getTableColumns(tableName: string) {
    if (tableColumnsCache[tableName]) return tableColumnsCache[tableName];
    try {
        const [rows]: any = await pool.execute(`SHOW COLUMNS FROM ${tableName}`);
        const cols = rows.map((r: any) => r.Field);
        tableColumnsCache[tableName] = cols;
        return cols;
    } catch (e: any) {
        console.error(`Erro ao ler colunas de ${tableName}:`, e.message);
        return [];
    }
}

async function syncGeneric(tableName: string, data: any[], schoolId: string) {
    if (!data || !Array.isArray(data)) return;
    
    const dbColumns = await getTableColumns(tableName);
    if (dbColumns.length === 0) throw new Error(`Tabela ${tableName} não encontrada.`);

    for (const item of data) {
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

        const escapedKeys = validKeys.map(k => `\`${k}\``);
        const placeholders = validKeys.map(() => '?').join(', ');
        const updates = validKeys.map(k => `\`${k}\`=VALUES(\`${k}\`)`).join(', ');

        const sql = `INSERT INTO ${tableName} (${escapedKeys.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
        
        try {
            await pool.execute(sql, values);
        } catch (error: any) {
            console.error(`Erro no sync da tabela ${tableName}:`, error.message);
            throw error;
        }
    }
}

async function startServer() {
    // Iniciar conexão em segundo plano para não bloquear o startup do servidor no Render
    connectDB().catch(err => console.error("Erro inicial na conexão DB:", err));

    app.get('/api/health', async (req, res) => {
        try {
            if (!pool) throw new Error("Pool não inicializado.");
            await pool.query("SELECT 1");
            res.json({ status: "online", database: "connected", zone: "Moçambique CAT" });
        } catch (err: any) {
            res.status(500).json({ status: "online", database: "error", error: err.message });
        }
    });

    app.post('/api/auth/login', async (req, res) => {
        const { schoolCode, email, password } = req.body;
        try {
            const cleanEmail = email ? email.trim().toLowerCase() : '';
            const cleanCode = schoolCode ? schoolCode.trim().toLowerCase() : '';

            if (cleanEmail === 'admin@sistema.com') {
                const [rows]: any = await pool.execute('SELECT * FROM users WHERE LOWER(email) = ? AND password = ?', [cleanEmail, password]);
                if (rows.length > 0) return res.json({ success: true, user: rows[0] });
            }

            const [rows]: any = await pool.execute(`
                SELECT u.*, s.status as schoolStatus, s.name as schoolName 
                FROM users u 
                INNER JOIN schools s ON u.schoolId = s.id 
                WHERE LOWER(s.accessCode) = ? AND LOWER(u.email) = ? AND u.password = ?
            `, [cleanCode, cleanEmail, password]);

            if (rows.length > 0) {
                const user = rows[0];
                if (user.schoolStatus === 'Bloqueado') return res.status(403).json({ success: false, message: 'O acesso da sua escola foi bloqueado.' });
                res.json({ success: true, user });
            } else {
                res.status(401).json({ success: false, message: 'Código ou credenciais inválidas.' });
            }
        } catch (err) { 
            res.status(500).json({ error: "Erro no servidor." }); 
        }
    });

    app.post('/api/auth/forgot-password', async (req, res) => {
        const { email } = req.body;
        try {
            const [users]: any = await pool.execute('SELECT u.name, u.schoolId, s.name as schoolName FROM users u LEFT JOIN schools s ON u.schoolId = s.id WHERE LOWER(u.email) = ?', [email.toLowerCase()]);
            if (users.length === 0) return res.status(404).json({ success: false, message: 'E-mail não encontrado.' });
            const user = users[0];
            const requestId = `pw_${Date.now()}`;
            await pool.execute(`INSERT INTO password_reset_requests (id, schoolId, schoolName, userEmail, userName, status) VALUES (?, ?, ?, ?, ?, 'Pendente')`, [requestId, user.schoolId, user.schoolName || 'Acesso Global', email, user.name]);
            res.json({ success: true, message: 'Solicitação enviada.' });
        } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/schools', async (req, res) => {
        try {
            const [rows]: any = await pool.execute('SELECT * FROM schools ORDER BY createdAt DESC');
            res.json(rows.map((s: any) => ({ ...s, subscription: typeof s.subscription === 'string' ? JSON.parse(s.subscription) : s.subscription })));
        } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/schools/sync', async (req, res) => {
        try {
            await syncGeneric('schools', req.body, 'SYSTEM');
            res.json({ success: true });
        } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/schools/:id', async (req, res) => {
        try {
            await pool.execute('DELETE FROM schools WHERE id = ?', [req.params.id]);
            res.json({ success: true });
        } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/saas/password-requests', async (req, res) => {
        try {
            const [rows]: any = await pool.execute('SELECT * FROM password_reset_requests ORDER BY createdAt DESC');
            res.json(rows);
        } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/school/:id/full-data', async (req, res) => {
        const sid = req.params.id;
        try {
            const tables = ['users', 'students', 'turmas', 'academic_years', 'expenses', 'notifications', 'school_requests', 'discussion_topics'];
            const results: any = {};
            for (const table of tables) {
                const [rows]: any = await pool.execute(`SELECT * FROM ${table} WHERE schoolId = ?`, [sid]);
                results[table] = rows.map((r: any) => {
                    const jsonCols = ['subscription', 'subjectsByClass', 'teachers', 'studentIds', 'financialProfile', 'documents', 'grades', 'examGrades', 'attendance', 'behavior', 'behaviorEvaluations', 'payments', 'extraCharges', 'items', 'metadata', 'participantIds', 'availability', 'scores', 'schedule'];
                    const item = { ...r };
                    jsonCols.forEach(col => { if(item[col] && typeof item[col] === 'string') try { item[col] = JSON.parse(item[col]); } catch(e){} });
                    return item;
                });
            }
            const [settingsRows]: any = await pool.execute('SELECT * FROM school_settings WHERE schoolId = ?', [sid]);
            if (settingsRows.length > 0) {
                const s = settingsRows[0];
                results.settings = typeof s.general_settings === 'string' ? JSON.parse(s.general_settings) : s.general_settings;
                results.financial = typeof s.financial_settings === 'string' ? JSON.parse(s.financial_settings) : s.financial_settings;
            }
            const [msgs]: any = await pool.execute('SELECT m.* FROM discussion_messages m JOIN discussion_topics t ON m.topicId = t.id WHERE t.schoolId = ?', [sid]);
            results.messages = msgs;
            res.json(results);
        } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/school/:id/sync/:key', async (req, res) => {
        const sid = req.params.id;
        const key = req.params.key;
        const data = req.body;
        try {
            const keyMap: Record<string, string> = {
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
        } catch (err: any) { 
            res.status(500).json({ error: err.message }); 
        }
    });

    // Vite middleware for development
    if (process.env.NODE_ENV !== "production") {
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: "spa",
        });
        app.use(vite.middlewares);
    } else {
        app.use(express.static(path.join(__dirname, 'dist')));
        app.get('*', (req, res) => {
            res.sendFile(path.join(__dirname, 'dist', 'index.html'));
        });
    }

    const PORT = process.env.PORT || 3000;
    app.listen(Number(PORT), "0.0.0.0", () => {
        console.log(`Servidor v2.9 CAT Moçambique na porta ${PORT}`);
    });
}

startServer().catch(err => {
    console.error("Erro fatal ao iniciar o servidor:", err);
    process.exit(1);
});
