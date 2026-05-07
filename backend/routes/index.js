
const express = require('express');
const router = express.Router();

router.use('/auth', require('./auth.routes'));
router.use('/audit', require('./audit.routes'));
router.use('/billing', require('./billing.routes'));
router.use('/clients', require('./client.routes'));
router.use('/cases', require('./case.routes'));
router.use('/calendar', require('./calendar.routes'));
router.use('/documents', require('./documents.routes'));
router.use('/intake', require('./intake.routes'));

module.exports = router;
