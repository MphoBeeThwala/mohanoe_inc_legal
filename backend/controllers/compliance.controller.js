const complianceService = require('../services/compliance.service');

async function summary(req, res) {
  try {
    const data = await complianceService.getComplianceSummary();
    res.status(200).json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function index(req, res) {
  try {
    const requests = await complianceService.listRequests({
      status: req.query.status,
      requestType: req.query.requestType,
    });
    res.status(200).json(requests);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function create(req, res) {
  try {
    const request = await complianceService.createRequest(req.body, req.auth);
    res.status(201).json(request);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function fulfill(req, res) {
  try {
    const request = await complianceService.fulfillRequest(
      req.params.requestId,
      req.body,
      req.auth,
    );
    res.status(200).json(request);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function exportData(req, res) {
  try {
    const data = await complianceService.buildDataExport(req.query);
    res.status(200).json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function retentionSweep(req, res) {
  try {
    const data = await complianceService.runRetentionSweep(req.auth);
    res.status(200).json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

module.exports = {
  create,
  exportData,
  fulfill,
  index,
  retentionSweep,
  summary,
};
