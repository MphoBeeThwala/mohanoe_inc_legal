const authService = require('../services/auth.service');

async function register(req, res) {
  try {
    const result = await authService.registerUser(req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function login(req, res) {
  try {
    const result = await authService.loginUser(req.body);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function me(req, res) {
  try {
    const user = await authService.getSessionUser(req.auth.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ user });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function config(_req, res) {
  res.status(200).json(authService.getAuthConfig());
}

async function seedAdmin(req, res) {
  try {
    const user = await authService.seedDefaultUsers();
    if (!user) {
      return res.status(400).json({
        message: 'DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD must be set to seed an admin user',
      });
    }

    res.status(200).json({ user });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

module.exports = {
  config,
  login,
  me,
  seedAdmin,
  register,
};
