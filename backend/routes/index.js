
const express = require('express');
const router = express.Router();

router.use('/auth', require('./auth.routes'));
router.use('/clients', require('./client.routes'));
router.use('/cases', require('./case.routes'));
router.use('/intake', require('./intake.routes'));

module.exports = router;
