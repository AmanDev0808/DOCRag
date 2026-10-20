import express from 'express';
import {
  processAiAction,
  askDocumentRag,
  indexDocumentForRag,
  removeDocumentRagIndex
} from '../controllers/aiController.js';
import { protect } from '../middleware/auth.js';
import { ragQueryLimiter, ragIndexLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

router.post('/process', protect, processAiAction);
router.post('/rag/ask', protect, ragQueryLimiter, askDocumentRag);
router.post('/rag/index/:documentId', protect, ragIndexLimiter, indexDocumentForRag);
router.delete('/rag/index/:documentId', protect, ragIndexLimiter, removeDocumentRagIndex);

export default router;
