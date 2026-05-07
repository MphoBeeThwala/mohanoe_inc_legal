const { randomUUID } = require('crypto');

const clients = [];

async function createClient(clientData = {}) {
  const name = String(clientData.name || '').trim();
  const email = String(clientData.email || '').trim();
  const phone = String(clientData.phone || '').trim();

  if (!name || !email || !phone) {
    const error = new Error('name, email, and phone are required');
    error.statusCode = 400;
    throw error;
  }

  const record = {
    id: randomUUID(),
    name,
    email,
    phone,
    createdAt: new Date().toISOString(),
  };

  clients.unshift(record);
  return record;
}

async function getAllClients() {
  return [...clients];
}

module.exports = {
  createClient,
  getAllClients,
};
