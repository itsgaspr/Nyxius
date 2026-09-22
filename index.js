import dotenv from 'dotenv';
import { startHeartbeat } from './src/config/db.js';
import { startBot } from './src/services/whatsappService.js';
import express from 'express'

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/ping', (req, res) => {
    res.send('Nyxius is online.');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

async function main() {
    try {
        console.log('🚀 Starting Nyxius...');
        startHeartbeat();
        await startBot();
    } catch (err) {
        console.error('❌ Failed to start bot:', err);
        process.exit(1);
    }
}

main();
