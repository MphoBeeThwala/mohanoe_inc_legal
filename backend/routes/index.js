
const express = require('express');
const router = express.Router();

router.use('/clients', require('./client.routes'));

module.exports = router;
