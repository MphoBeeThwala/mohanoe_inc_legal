const calendarService = require('../services/calendar.service');

async function index(req, res) {
  try {
    const events = await calendarService.listEvents();
    res.status(200).json(events);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function upcoming(req, res) {
  try {
    const events = await calendarService.getUpcomingEvents();
    res.status(200).json(events);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function create(req, res) {
  try {
    const event = await calendarService.createEvent(req.body, req.auth);
    res.status(201).json(event);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

module.exports = {
  create,
  index,
  upcoming,
};
