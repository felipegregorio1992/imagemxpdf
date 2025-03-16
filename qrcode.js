const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const app = express();

// Configuração da porta - usa a porta do ambiente ou 3001 como fallback
const port = process.env.PORT || 3001;

// Armazena o último QR code gerado
let lastQRCode = null;
let isWhatsAppReady = false;
let whatsappClient = null;

// Configuração do servidor Express
app.use(express.static(path.join(__dirname)));

// Configuração de CORS para a API
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Rota de teste para verificar se a API está funcionando
app.get('/api/test', (req, res) => {
    res.json({ status: 'API is working' });
});

// Rota para verificar o status do QR code
app.get('/api/status', (req, res) => {
    if (isWhatsAppReady) {
        res.json({ type: 'ready' });
    } else if (lastQRCode) {
        res.json({ 
            type: 'qr',
            qr: lastQRCode,
            timestamp: Date.now()
        });
    } else {
        res.json({ type: 'waiting' });
    }
});

// Rota para reiniciar o cliente do WhatsApp
app.post('/api/restart', async (req, res) => {
    try {
        if (whatsappClient) {
            await whatsappClient.destroy();
        }
        lastQRCode = null;
        isWhatsAppReady = false;
        initializeWhatsApp();
        res.json({ status: 'restarting' });
    } catch (error) {
        console.error('Erro ao reiniciar:', error);
        res.status(500).json({ error: 'Erro ao reiniciar o cliente' });
    }
});

// Função para obter as opções do puppeteer baseado no ambiente
function getPuppeteerConfig() {
    const browserlessToken = process.env.BROWSERLESS_TOKEN;
    
    if (process.env.NODE_ENV === 'production' && browserlessToken) {
        console.log('Usando configuração do Browserless.io');
        return {
            puppeteer: {
                browserWSEndpoint: `wss://chrome.browserless.io?token=${browserlessToken}`,
                args: ['--no-sandbox']
            }
        };
    } else {
        console.log('Usando configuração local');
        return {
            puppeteer: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ],
                headless: true
            }
        };
    }
}

// Inicializa o cliente do WhatsApp
async function initializeWhatsApp() {
    try {
        const options = getPuppeteerConfig();
        console.log('Iniciando cliente do WhatsApp com as opções:', JSON.stringify(options, null, 2));
        
        whatsappClient = new Client(options);

        whatsappClient.on('qr', async (qr) => {
            console.log('Novo QR Code gerado');
            try {
                lastQRCode = await qrcode.toDataURL(qr);
                console.log('QR Code convertido para DataURL');
            } catch (error) {
                console.error('Erro ao gerar QR code:', error);
            }
        });

        whatsappClient.on('ready', () => {
            console.log('Cliente WhatsApp conectado!');
            isWhatsAppReady = true;
            lastQRCode = null;
        });

        whatsappClient.on('disconnected', () => {
            console.log('Cliente WhatsApp desconectado');
            isWhatsAppReady = false;
        });

        whatsappClient.on('message', async (message) => {
            let tempFilePath = null;
            
            try {
                if (message.hasMedia) {
                    const media = await message.downloadMedia();
                    
                    if (!media || !media.data) {
                        throw new Error('Dados da mídia não encontrados');
                    }

                    if (!media.mimetype.startsWith('image/')) {
                        await message.reply('Por favor, envie apenas imagens.');
                        return;
                    }

                    await message.reply('Processando sua imagem... 🔄');

                    const imageBuffer = Buffer.from(media.data, 'base64');
                    console.log('Convertendo imagem para PDF...');
                    
                    const pdfBuffer = await convertImageToPDF(imageBuffer);
                    tempFilePath = await saveTempFile(pdfBuffer, '.pdf');
                    const pdfBase64 = (await fs.readFile(tempFilePath)).toString('base64');

                    const pdfMedia = new MessageMedia(
                        'application/pdf',
                        pdfBase64,
                        'documento.pdf'
                    );

                    await message.reply(pdfMedia);
                    await message.reply('Aqui está seu PDF! 📄');
                }
            } catch (error) {
                console.error('Erro ao processar mensagem:', error);
                await message.reply('Desculpe, ocorreu um erro ao processar sua imagem. Por favor, tente novamente.');
            } finally {
                if (tempFilePath) {
                    await cleanupTempFile(tempFilePath);
                }
            }
        });

        console.log('Iniciando cliente do WhatsApp...');
        await whatsappClient.initialize();
        console.log('Cliente do WhatsApp inicializado com sucesso');
        
    } catch (error) {
        console.error('Erro ao inicializar WhatsApp:', error);
        throw error;
    }
}

// Função para validar base64
function isValidBase64(str) {
    try {
        return Buffer.from(str, 'base64').toString('base64') === str;
    } catch (err) {
        return false;
    }
}

// Função para salvar arquivo temporário
async function saveTempFile(buffer, extension) {
    const tempPath = path.join(__dirname, `temp_${Date.now()}${extension}`);
    await fs.writeFile(tempPath, buffer);
    return tempPath;
}

// Função para converter imagem para PDF
async function convertImageToPDF(imageBuffer) {
    try {
        // Converte a imagem para PNG usando sharp
        const pngBuffer = await sharp(imageBuffer)
            .png()
            .toBuffer();

        // Cria um novo documento PDF
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595, 842]); // Tamanho A4

        // Incorpora a imagem no PDF
        const pngImage = await pdfDoc.embedPng(pngBuffer);
        
        // Calcula as dimensões mantendo a proporção
        const pageWidth = page.getWidth();
        const pageHeight = page.getHeight();
        const imageWidth = pngImage.width;
        const imageHeight = pngImage.height;
        
        // Calcula a escala para ajustar a imagem na página
        const scale = Math.min(
            (pageWidth * 0.9) / imageWidth,
            (pageHeight * 0.9) / imageHeight
        );
        
        const width = imageWidth * scale;
        const height = imageHeight * scale;

        // Desenha a imagem na página centralizada
        page.drawImage(pngImage, {
            x: (pageWidth - width) / 2,
            y: (pageHeight - height) / 2,
            width,
            height,
        });

        // Salva o PDF como buffer
        return await pdfDoc.save();
    } catch (error) {
        console.error('Erro ao converter imagem para PDF:', error);
        throw error;
    }
}

// Função para limpar arquivos temporários
async function cleanupTempFile(filePath) {
    try {
        await fs.unlink(filePath);
    } catch (error) {
        console.error('Erro ao limpar arquivo temporário:', error);
    }
}

// Inicia o servidor em desenvolvimento
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, '0.0.0.0', () => {
        console.log(`Servidor rodando na porta ${port}`);
    });
}

// Inicia o WhatsApp
console.log(`Iniciando em modo ${process.env.NODE_ENV || 'desenvolvimento'}...`);
initializeWhatsApp().catch(err => {
    console.error('Erro ao inicializar:', err);
});

// Exporta o app para o Vercel
module.exports = app; 