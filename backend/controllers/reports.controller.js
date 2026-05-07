const reportsService = require('../services/reports.service');

async function dashboard(req, res) {
  try {
    const report = await reportsService.buildDashboard();
    res.status(200).json(report);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function generate(req, res) {
  try {
    const report = await reportsService.generateSnapshot(req.body, req.auth);
    res.status(201).json(report);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function index(req, res) {
  try {
    const reports = await reportsService.listSnapshots();
    res.status(200).json(reports);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

module.exports = {
  dashboard,
  generate,
  index,
};
