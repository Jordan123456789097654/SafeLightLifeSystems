// Local dev server: runs the exact same handler Vercel uses.  `npm start` -> http://localhost:3000
const express = require('express');
const path = require('path');
const handler = require('./api/index.js');

const app = express();
app.use(express.json());
app.use('/api', (req, res) => handler(req, res));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SafeLight Central Station on http://localhost:${PORT}`));
