// server/src/routes/qr.ts
import express from 'express';
import QRCode from 'qrcode';
import { getSetting } from '../db.js';

export const qrRouter = express.Router();

// Handle CORS preflight requests for QR endpoint
qrRouter.options('/api/qr', (req, res) => {
  const allowedOrigins = process.env.ORIGIN?.split(',').map(origin => origin.trim()) || ['*'];
  const requestOrigin = req.get('origin') || '';
  const allowOrigin = allowedOrigins.includes('*') || allowedOrigins.includes(requestOrigin);
  
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : requestOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  }
  
  res.status(204).end();
});

qrRouter.get('/api/qr', async (req, res) => {
  try {
    const gatewayEnabled = await getSetting('remote_gateway.enabled');
    const gatewayUrl = String(await getSetting('remote_gateway.url') ?? '').trim().replace(/\/+$/, '');
    let requestsUrl = gatewayEnabled === true && gatewayUrl ? gatewayUrl : '';

    if (!requestsUrl) {
      // Get the web app URL from environment variable.
      // Format should be like: http://192.168.1.100:5173 or http://hostname:5173.
      // Falls back to using the API server's host with port 5173.
      let webAppUrl = process.env.WEB_APP_URL;
      
      if (!webAppUrl) {
        const host = req.get('host') || 'localhost:5174';
        const hostWithoutPort = host.split(':')[0];
        webAppUrl = `${req.protocol}://${hostWithoutPort}:5173`;
      }
      
      requestsUrl = `${webAppUrl.replace(/\/+$/, '')}/requests`;
    }
    
    console.log(`Generating QR code for: ${requestsUrl}`);
    
    const qrDataUrl = await QRCode.toDataURL(requestsUrl, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    
    // Convert data URL to buffer and send as image
    const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
    const img = Buffer.from(base64Data, 'base64');
    
    // Get allowed origins from environment
    const allowedOrigins = process.env.ORIGIN?.split(',').map(origin => origin.trim()) || ['*'];
    const requestOrigin = req.get('origin') || '';
    
    // Determine if we should allow this origin
    const allowOrigin = allowedOrigins.includes('*') || allowedOrigins.includes(requestOrigin);
    
    const headers: Record<string, string> = {
      'Content-Type': 'image/png',
      'Content-Length': String(img.length),
      'Cache-Control': 'public, max-age=60',
    };
    
    // Add CORS headers to allow cross-origin image loading
    if (allowOrigin) {
      headers['Access-Control-Allow-Origin'] = allowedOrigins.includes('*') ? '*' : requestOrigin;
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
    
    res.writeHead(200, headers);
    
    res.end(img);
  } catch (error) {
    console.error('QR generation failed:', error);
    res.status(500).send('QR generation failed');
  }
});