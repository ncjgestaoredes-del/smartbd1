
import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

// FORÇAR FUSO HORÁRIO DE MOÇAMBIQUE NO PROCESSO NODE
process.env.TZ = 'Africa/Maputo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
    const app = express();

    app.use(cors());
    app.use(express.json({ limit: '100mb' }));
    app.use(express.urlencoded({ extended: true, limit: '100mb' }));

    /* ================= DATABASE ================= */
    
    const requiredEnv = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
    const missingEnv = requiredEnv.filter(key => !process.env[key]);

    if (missingEnv.length > 0) {
        console.error(`❌ Variáveis de ambiente ausentes: ${missingEnv.join(', ')}`);
        console.warn("⚠️ Certifique-se de configurar as variáveis no menu Settings do AI Studio.");
    }

    const dbConfig = {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'test',
        waitForConnections: true,
        connectionLimit: 10,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        timezone: '+02:00'
    };

    let pool: mysql.Pool;
    let dbConnected = false;

    async function connectDB() {
        if (missingEnv.length > 0) return;
        try {
            pool = mysql.createPool(dbConfig);
            // Testar conexão
            await pool.query("SELECT 1");
            await pool.query("SET time_zone = '+02:00'");
            dbConnected = true;
            console.log("✅ MySQL conectado (CAT Moçambique)");
        } catch (err: any) {
            dbConnected = false;
            console.error("❌ Erro MySQL:", err.message);
        }
    }

    /* ================= CACHE COLUNAS ================= */

    const tableColumnsCache: Record<string, string[]> = {};

    async function getTableColumns(tableName: string) {
        if (tableColumnsCache[tableName]) {
            return tableColumnsCache[tableName];
        }

        const [rows]: any = await pool.execute(`SHOW COLUMNS FROM ${tableName}`);
        const cols = rows.map((r: any) => r.Field);
        tableColumnsCache[tableName] = cols;
        return cols;
    }

    /* ================= SYNC GENERICO ================= */

    async function syncGeneric(tableName: string, data: any, schoolId: string) {
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

    app.get('/api/health', (req: express.Request, res: express.Response) => {
        res.json({
            status: "online",
            version: "v2.9.1",
            database: dbConnected ? "connected" : "disconnected",
            missingEnv: missingEnv.length > 0 ? missingEnv : undefined
        });
    });

    /* LOGIN */

    app.post('/api/auth/login', async (req: express.Request, res: express.Response) => {
        if (!dbConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Banco de dados não conectado. Verifique as configurações." 
            });
        }
        try {
            const { schoolCode, email, password } = req.body;

            const cleanEmail = email.trim().toLowerCase();
            const cleanCode = schoolCode.trim().toLowerCase();

            const [rows]: any = await pool.execute(`
            SELECT u.*, s.status as schoolStatus
            FROM users u
            INNER JOIN schools s ON u.schoolId = s.id
            WHERE LOWER(s.accessCode)=? AND LOWER(u.email)=? AND u.password=?
            `, [cleanCode, cleanEmail, password]);

            if (rows.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: "Credenciais inválidas"
                });
            }

            const user = rows[0];

            if (user.schoolStatus === "Bloqueado") {
                return res.status(403).json({
                    success: false,
                    message: "Escola bloqueada"
                });
            }

            res.json({
                success: true,
                user
            });

        } catch (err: any) {
            res.status(500).json({ message: err.message });
        }
    });

    /* LISTAR ESCOLAS */

    app.get('/api/schools', async (req: express.Request, res: express.Response) => {
        if (!dbConnected) {
            return res.status(503).json({ 
                message: "Banco de dados não conectado. Verifique as configurações." 
            });
        }
        try {
            const [rows] = await pool.execute(
                "SELECT * FROM schools ORDER BY createdAt DESC"
            );
            res.json(rows);
        } catch (err: any) {
            res.status(500).json({ message: err.message });
        }
    });

    /* DELETE ESCOLA */

    app.delete('/api/schools/:id', async (req: express.Request, res: express.Response) => {
        if (!dbConnected) {
            return res.status(503).json({ 
                message: "Banco de dados não conectado. Verifique as configurações." 
            });
        }
        try {
            await pool.execute(
                "DELETE FROM schools WHERE id=?",
                [req.params.id as string]
            );
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ message: err.message });
        }
    });

    /* FULL DATA DA ESCOLA */

    app.get('/api/school/:id/full-data', async (req: express.Request, res: express.Response) => {
        if (!dbConnected) {
            return res.status(503).json({ message: "Banco de dados não conectado." });
        }
        try {
            const sid = req.params.id as string;
            
            // Buscar tudo em paralelo
            const [users]: any = await pool.execute("SELECT * FROM users WHERE schoolId=?", [sid]);
            const [students]: any = await pool.execute("SELECT * FROM students WHERE schoolId=?", [sid]);
            const [academic_years]: any = await pool.execute("SELECT * FROM academic_years WHERE schoolId=?", [sid]);
            const [settings_rows]: any = await pool.execute("SELECT * FROM school_settings WHERE schoolId=?", [sid]);
            const [turmas]: any = await pool.execute("SELECT * FROM turmas WHERE schoolId=?", [sid]);
            const [expenses]: any = await pool.execute("SELECT * FROM expenses WHERE schoolId=?", [sid]);
            const [topics]: any = await pool.execute("SELECT * FROM discussion_topics WHERE schoolId=?", [sid]);
            const [notifications]: any = await pool.execute("SELECT * FROM notifications WHERE schoolId=?", [sid]);
            const [requests]: any = await pool.execute("SELECT * FROM school_requests WHERE schoolId=?", [sid]);

            // Processar settings
            let settings = {};
            let financial = {};
            if (settings_rows.length > 0) {
                settings = settings_rows[0].general_settings || {};
                financial = settings_rows[0].financial_settings || {};
            }

            res.json({
                users,
                students,
                academic_years,
                settings,
                financial,
                turmas,
                expenses,
                topics,
                messages: [], // Mensagens são carregadas por tópico geralmente, mas App.tsx espera aqui
                notifications,
                requests
            });

        } catch (err: any) {
            res.status(500).json({ message: err.message });
        }
    });

    /* SYNC ESCOLA ESPECÍFICO */

    app.post('/api/school/:id/sync/:table', async (req: express.Request, res: express.Response) => {
        if (!dbConnected) {
            return res.status(503).json({ message: "Banco de dados não conectado." });
        }
        try {
            const { id, table } = req.params as { id: string, table: string };
            
            if (table === "settings" || table === "financial") {
                // Caso especial para settings que estão na mesma tabela
                const field = table === "settings" ? "general_settings" : "financial_settings";
                const sql = `
                    INSERT INTO school_settings (schoolId, ${field})
                    VALUES (?, ?)
                    ON DUPLICATE KEY UPDATE ${field} = VALUES(${field})
                `;
                await pool.execute(sql, [id, JSON.stringify(req.body)]);
            } else {
                await syncGeneric(table, req.body, id);
            }
            
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ message: err.message });
        }
    });

    /* SYNC */

    app.post('/api/schools/sync', async (req: express.Request, res: express.Response) => {
        if (!dbConnected) {
            return res.status(503).json({ 
                message: "Banco de dados não conectado. Verifique as configurações." 
            });
        }
        try {
            await syncGeneric("schools", req.body, "SYSTEM");
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ message: err.message });
        }
    });

    /* ================= FRONTEND ================= */

    // Vite middleware for development
    if (process.env.NODE_ENV !== "production") {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: "spa",
        });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(process.cwd(), 'dist');
        
        import('fs').then(fs => {
            if (!fs.existsSync(distPath)) {
                console.warn("⚠️ Pasta 'dist' não encontrada. Certifique-se de rodar 'npm run build' para gerar os arquivos do frontend.");
            }
        });

        app.use(express.static(distPath));
        app.get('*all', (req: express.Request, res: express.Response) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    /* ================= START SERVER ================= */

    const PORT = Number(process.env.PORT) || 3000;

    await connectDB();

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Servidor rodando porta ${PORT}`);
    });
}

startServer();
