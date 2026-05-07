const intakeService = require('../services/intake.service');

async function createSubmission(req, res) {
  try {
    const submission = await intakeService.createSubmission(req.body);
    res.status(201).json(submission);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function listSubmissions(req, res) {
  try {
    const submissions = await intakeService.listSubmissions();
    res.status(200).json(submissions);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function getSubmission(req, res) {
  try {
    const submission = await intakeService.getSubmission(req.params.id);
    if (!submission) {
      return res.status(404).json({ message: 'Intake submission not found' });
    }

    res.status(200).json(submission);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function assessSubmission(req, res) {
  try {
    const assessment = await intakeService.assessSubmission(req.params.id);
    res.status(200).json(assessment);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function listCases(req, res) {
  try {
    const cases = await intakeService.listCases();
    res.status(200).json(cases);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function getSummary(req, res) {
  try {
    const summary = await intakeService.getSummary();
    res.status(200).json(summary);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

module.exports = {
  assessSubmission,
  createSubmission,
  getSubmission,
  getSummary,
  listCases,
  listSubmissions,
};
