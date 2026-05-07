const auditService = require('../services/audit.service');

async function index(req, res) {
  try {
    const events = await auditService.listEvents({
      entityType: req.query.entityType,
      entityId: req.query.entityId,
    });
    res.status(200).json(events);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function verify(req, res) {
  try {
    const status = await auditService.verifyEventChain();
    res.status(200).json(status);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

module.exports = {
  index,
  verify,
};
