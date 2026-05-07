const notificationsService = require('../services/notifications.service');

async function index(req, res) {
  try {
    const notifications = await notificationsService.listNotifications({
      recipientRole: req.query.recipientRole,
      isRead:
        req.query.isRead === 'true'
          ? true
          : req.query.isRead === 'false'
            ? false
            : undefined,
    });
    res.status(200).json(notifications);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function create(req, res) {
  try {
    const notification = await notificationsService.createNotification(req.body, req.auth);
    res.status(201).json(notification);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function markRead(req, res) {
  try {
    const notification = await notificationsService.markRead(req.params.notificationId, req.auth);
    res.status(200).json(notification);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function unread(req, res) {
  try {
    const count = await notificationsService.unreadCount(req.query.recipientRole || null);
    res.status(200).json({ count });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

module.exports = {
  create,
  index,
  markRead,
  unread,
};
