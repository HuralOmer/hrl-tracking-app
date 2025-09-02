const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.json({ 
    ok: true, 
    message: 'HRL Tracking App is running!',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Test server listening on port ${PORT}`);
});
