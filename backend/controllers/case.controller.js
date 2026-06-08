const caseService = require('../services/case.service');

async function index(req, res) {
  try {
    const cases = await caseService.getCasesIndex();
    res.status(200).json(cases);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function show(req, res) {
  try {
    const current = await caseService.getCase(req.params.caseId);
    if (!current) {
      return res.status(404).json({ message: 'Case not found' });
    }

    res.status(200).json(current);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function addTask(req, res) {
  try {
    const task = await caseService.addTask(req.params.caseId, req.body, req.auth);
    res.status(201).json(task);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function completeTask(req, res) {
  try {
    const task = await caseService.completeTask(
      req.params.caseId,
      req.params.taskId,
      req.auth,
    );
    res.status(200).json(task);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function updateStatus(req, res) {
  try {
    const current = await caseService.updateCaseStatus(
      req.params.caseId,
      req.body,
      req.auth,
    );
    res.status(200).json(current);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function addTimeline(req, res) {
  try {
    const entry = await caseService.addTimeline(
      req.params.caseId,
      req.body,
      req.auth,
    );
    res.status(201).json(entry);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

module.exports = {
  addTask,
  addTimeline,
  completeTask,
  index,
  show,
  updateStatus,
};
