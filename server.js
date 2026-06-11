const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const X_SUPER_PROPERTIES = 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InB0LUJSIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyMC4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTIwLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbmdfZG9tYWluIjoiIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6OTk5OTk5LCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsfQ==';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9217 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(baseMs, rangeMs = 1500) {
    return baseMs + Math.floor(Math.random() * rangeMs);
}

function getTaskDuration(target) {
    if (target >= 60) {
        const m = Math.floor(target / 60), s = target % 60;
        return s > 0 ? `${m}min ${s}s` : `${m} minutos`;
    }
    return `${Math.floor(target)} segundos`;
}

function parseRewardText(r) {
    if (!r) return 'Recompensa desconhecida';
    if (r.type === 4) return `${r.orb_quantity} Orbs`;
    if (r.type === 3) return r.messages?.name || 'Decoração de Avatar';
    if (r.type === 1) return r.messages?.name || 'Item no jogo';
    return 'Recompensa desconhecida';
}

function getBestTask(tasks) {
    const TASK_PRIORITY = ['PLAY_ON_DESKTOP', 'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE'];
    let selectedTask = null, bestPriority = 999;
    for (const [type, data] of Object.entries(tasks)) {
        const p = TASK_PRIORITY.indexOf(type);
        if (p !== -1 && p < bestPriority) {
            bestPriority = p;
            selectedTask = { taskType: type, taskData: data };
        }
    }
    return selectedTask;
}

async function discordRequest(token, endpoint, method = 'GET', body = null) {
    try {
        const headers = {
            'authorization': token,
            'x-super-properties': X_SUPER_PROPERTIES,
            'user-agent': USER_AGENT,
            'accept-language': 'pt-BR,pt;q=0.9',
            'origin': 'https://discord.com',
            'referer': 'https://discord.com/channels/@me'
        };
        if (body) headers['content-type'] = 'application/json';

        const response = await axios({
            method,
            url: `https://discord.com/api/v9${endpoint}`,
            headers,
            data: body,
            validateStatus: () => true
        });
        return response;
    } catch (err) {
        return { status: 500, data: null };
    }
}

// Health check
app.get('/api/health', (req, res) => {
    console.log('✅ Health check chamado');
    res.json({ status: 'online', timestamp: new Date().toISOString() });
});

// Login
app.post('/api/login', async (req, res) => {
    console.log('📝 Login chamado');
    const { token } = req.body;
    if (!token) return res.json({ success: false, error: 'Token obrigatório' });

    const response = await discordRequest(token, '/users/@me', 'GET');
    if (response.status !== 200) {
        return res.json({ success: false, error: 'Token inválido' });
    }

    const user = response.data;
    res.json({
        success: true,
        user: {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            global_name: user.global_name,
            avatar: user.avatar
        }
    });
});

// List quests
app.post('/api/quests/list', async (req, res) => {
    console.log('📋 Listar quests chamado');
    const { token } = req.body;
    if (!token) return res.json({ success: false, error: 'Token obrigatório' });

    const response = await discordRequest(token, '/quests/@me', 'GET');
    if (response.status !== 200 || !response.data?.quests) {
        return res.json({ success: true, quests: [] });
    }

    const now = new Date();
    const quests = [];

    for (const quest of response.data.quests) {
        if (new Date(quest.config.expires_at) < now) continue;
        if (quest.user_status?.completed_at) continue;

        const tasks = quest.config.task_config_v2?.tasks || {};
        const selectedTask = getBestTask(tasks);
        if (!selectedTask) continue;

        const target = selectedTask.taskData.target || 0;
        const rewardText = parseRewardText(quest.config.rewards_config?.rewards?.[0]);

        quests.push({
            id: quest.id,
            name: quest.config.messages.quest_name,
            description: quest.config.messages.quest_description || 'Complete esta missão para ganhar recompensas',
            type: selectedTask.taskType,
            target: target,
            progress: 0,
            reward: rewardText,
            enrolled: !!quest.user_status?.enrolled_at,
            completed: false
        });
    }

    res.json({ success: true, quests });
});

// Complete single quest
app.post('/api/quests/complete', async (req, res) => {
    console.log('🎯 Complete quest chamado');
    const { token, questId } = req.body;
    if (!token || !questId) {
        return res.json({ success: false, error: 'Token e questId obrigatórios' });
    }

    const logs = [];
    const addLog = (msg, type = 'info') => {
        logs.push({ message: msg, type, timestamp: new Date().toISOString() });
        console.log(msg);
    };

    try {
        const questsRes = await discordRequest(token, '/quests/@me', 'GET');
        const quest = questsRes.data?.quests?.find(q => q.id === questId);
        
        if (!quest) {
            addLog('❌ Missão não encontrada', 'error');
            return res.json({ success: false, error: 'Missão não encontrada', logs });
        }

        const tasks = quest.config.task_config_v2?.tasks || {};
        const selectedTask = getBestTask(tasks);
        if (!selectedTask) {
            addLog('❌ Nenhuma tarefa disponível para esta missão', 'error');
            return res.json({ success: false, error: 'Sem tarefa disponível', logs });
        }

        const taskType = selectedTask.taskType;
        const target = selectedTask.taskData.target || 0;
        const questName = quest.config.messages.quest_name;

        addLog(`🎯 Iniciando: ${questName}`, 'info');
        addLog(`📋 Tipo: ${taskType} | Duração: ${getTaskDuration(target)}`, 'info');

        if (!quest.user_status?.enrolled_at) {
            addLog(`📝 Inscrevendo na missão...`, 'info');
            await discordRequest(token, `/quests/${questId}/enroll`, 'POST', { location: 11, is_targeted: false, metadata_raw: null });
            addLog(`✅ Inscrito com sucesso`, 'success');
            await sleep(2000);
        }

        let currentProgress = 0;

        if (taskType.startsWith('WATCH_')) {
            let timestamp = 0;
            while (currentProgress < target) {
                const progressRes = await discordRequest(token, `/quests/${questId}/video-progress`, 'POST', { timestamp });
                
                if (progressRes.status === 429) {
                    timestamp = Math.max(0, timestamp - 10);
                    await sleep(jitter(8000));
                    continue;
                }

                if (progressRes.status === 200 && progressRes.data.completed_at) {
                    currentProgress = target;
                    break;
                }

                currentProgress = timestamp;
                timestamp += 10;
                addLog(`⏳ Progresso: ${Math.min(currentProgress, target)}/${target} segundos`, 'info');
                
                if (currentProgress >= target) break;
                await sleep(jitter(2500, 2500));
            }
        } else if (taskType.startsWith('PLAY_')) {
            const streamKey = `call:${questId}:1`;
            let stuckCounter = 0;
            const MAX_STUCK = 8;

            while (currentProgress < target) {
                const progressRes = await discordRequest(token, `/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: false });
                
                if (progressRes.status === 429) {
                    await sleep(jitter(8000));
                    continue;
                }

                if (progressRes.status === 200) {
                    const data = progressRes.data;
                    
                    if (data.completed_at || data.user_status?.completed_at) {
                        currentProgress = target;
                        break;
                    }

                    const newProgress = data.progress?.[taskType]?.value ?? currentProgress;
                    
                    if (newProgress > currentProgress) {
                        currentProgress = newProgress;
                        stuckCounter = 0;
                        addLog(`⏳ Progresso: ${Math.min(currentProgress, target)}/${target} ${target > 60 ? 'minutos' : 'segundos'}`, 'info');
                        if (currentProgress >= target) {
                            await discordRequest(token, `/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: true });
                            break;
                        }
                    } else {
                        stuckCounter++;
                        if (stuckCounter >= MAX_STUCK) {
                            await discordRequest(token, `/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: true });
                            currentProgress = target;
                            break;
                        }
                    }
                }
                await sleep(jitter(24000, 3000));
            }
        }

        addLog(`✅ Missão concluída! Recompensa recebida!`, 'success');
        res.json({ success: true, logs });

    } catch (error) {
        addLog(`❌ Erro: ${error.message}`, 'error');
        res.json({ success: false, error: error.message, logs });
    }
});

// Complete all quests
app.post('/api/quests/complete-all', async (req, res) => {
    console.log('⚡ Complete all chamado');
    const { token } = req.body;
    if (!token) return res.json({ success: false, error: 'Token obrigatório' });

    const logs = [];
    const addLog = (msg, type = 'info') => {
        logs.push({ message: msg, type, timestamp: new Date().toISOString() });
        console.log(msg);
    };

    try {
        const questsRes = await discordRequest(token, '/quests/@me', 'GET');
        const now = new Date();
        const availableQuests = (questsRes.data?.quests || []).filter(q => {
            if (new Date(q.config.expires_at) < now) return false;
            if (q.user_status?.completed_at) return false;
            return true;
        });

        addLog(`📋 Encontradas ${availableQuests.length} missões disponíveis`, 'success');

        let completed = 0;
        for (const quest of availableQuests) {
            const tasks = quest.config.task_config_v2?.tasks || {};
            const selectedTask = getBestTask(tasks);
            if (!selectedTask) continue;

            const questId = quest.id;
            const taskType = selectedTask.taskType;
            const target = selectedTask.taskData.target || 0;
            const questName = quest.config.messages.quest_name;

            addLog(`\n🎯 Iniciando: ${questName}`, 'info');
            addLog(`📋 Tipo: ${taskType} | Duração: ${getTaskDuration(target)}`, 'info');

            if (!quest.user_status?.enrolled_at) {
                addLog(`📝 Inscrevendo na missão...`, 'info');
                await discordRequest(token, `/quests/${questId}/enroll`, 'POST', { location: 11, is_targeted: false, metadata_raw: null });
                addLog(`✅ Inscrito com sucesso`, 'success');
                await sleep(2000);
            }

            let currentProgress = 0;

            if (taskType.startsWith('WATCH_')) {
                let timestamp = 0;
                while (currentProgress < target) {
                    const progressRes = await discordRequest(token, `/quests/${questId}/video-progress`, 'POST', { timestamp });
                    if (progressRes.status === 429) {
                        timestamp = Math.max(0, timestamp - 10);
                        await sleep(jitter(8000));
                        continue;
                    }
                    if (progressRes.status === 200 && progressRes.data.completed_at) {
                        currentProgress = target;
                        break;
                    }
                    currentProgress = timestamp;
                    timestamp += 10;
                    if (currentProgress >= target) break;
                    await sleep(jitter(2500, 2500));
                }
            } else if (taskType.startsWith('PLAY_')) {
                const streamKey = `call:${questId}:1`;
                let stuckCounter = 0;
                const MAX_STUCK = 8;

                while (currentProgress < target) {
                    const progressRes = await discordRequest(token, `/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: false });
                    if (progressRes.status === 429) {
                        await sleep(jitter(8000));
                        continue;
                    }
                    if (progressRes.status === 200) {
                        const data = progressRes.data;
                        if (data.completed_at || data.user_status?.completed_at) {
                            currentProgress = target;
                            break;
                        }
                        const newProgress = data.progress?.[taskType]?.value ?? currentProgress;
                        if (newProgress > currentProgress) {
                            currentProgress = newProgress;
                            stuckCounter = 0;
                            if (currentProgress >= target) {
                                await discordRequest(token, `/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: true });
                                break;
                            }
                        } else {
                            stuckCounter++;
                            if (stuckCounter >= MAX_STUCK) {
                                await discordRequest(token, `/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: true });
                                currentProgress = target;
                                break;
                            }
                        }
                    }
                    await sleep(jitter(24000, 3000));
                }
            }

            addLog(`✅ Missão concluída!`, 'success');
            completed++;
            await sleep(5000);
        }

        addLog(`\n🏁 ${completed}/${availableQuests.length} missões concluídas!`, 'success');
        res.json({ success: true, logs, completed, total: availableQuests.length });

    } catch (error) {
        addLog(`❌ Erro: ${error.message}`, 'error');
        res.json({ success: false, error: error.message, logs });
    }
});

// Rota principal - serve o index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║   🎯 VIBEQUESTS - Servidor Rodando!                           ║
║                                                                ║
║   🚀 Servidor: http://localhost:${PORT}                        ║
║   📡 Status: Online                                           ║
║   ✅ API endpoints disponíveis:                               ║
║      GET  /api/health                                         ║
║      POST /api/login                                          ║
║      POST /api/quests/list                                    ║
║      POST /api/quests/complete                                ║
║      POST /api/quests/complete-all                            ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
    `);
});
