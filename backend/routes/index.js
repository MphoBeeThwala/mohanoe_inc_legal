
const express = require('express');
const router = express.Router();

router.use('/clients', require('./client.routes'));
router.use('/intake', require('./intake.routes'));

module.exports = router;
