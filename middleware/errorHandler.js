function errorHandler(err, req, res, next) {
  console.error('Error:', err.message, err.stack);
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Validation échouée: ' + err.message });
  }
  
  if (err.name === 'UnauthorizedError' || err.message === 'Token invalide.') {
    return res.status(401).json({ error: 'Non authentifié.' });
  }
  
  if (err.message.includes('CORS')) {
    return res.status(403).json({ error: 'CORS - Accès refusé.' });
  }
  
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Erreur serveur interne.' 
      : err.message,
  });
}

module.exports = errorHandler;
