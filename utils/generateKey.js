const crypto = require('crypto');

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) {
      group += chars[crypto.randomInt(0, chars.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

module.exports = { generateKey };
