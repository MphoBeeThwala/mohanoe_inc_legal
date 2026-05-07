const documentsService = require('../services/documents.service');

async function index(req, res) {
  try {
    const documents = await documentsService.listDocuments();
    res.status(200).json(documents);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function show(req, res) {
  try {
    const document = await documentsService.getDocument(req.params.documentId);
    if (!document) {
      return res.status(404).json({ message: 'Document not found' });
    }

    res.status(200).json(document);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function create(req, res) {
  try {
    const document = await documentsService.createDocument(req.body, req.auth);
    res.status(201).json(document);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function sign(req, res) {
  try {
    const document = await documentsService.signDocument(req.params.documentId, req.auth);
    res.status(200).json(document);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

module.exports = {
  create,
  index,
  show,
  sign,
};
