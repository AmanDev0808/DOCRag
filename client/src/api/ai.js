import API from './axios';

/**
 * Send request to AI Assistant
 * @param {Object} payload - { action: 'generate'|'rephrase'|'tone'|'summarize', prompt?, text?, tone? }
 */
export const processAiAssistant = async (payload) => {
  const response = await API.post('/ai/process', payload);
  return response.data;
};

export const askDocumentRag = async ({ documentId, question }) => {
  const response = await API.post('/ai/rag/ask', { documentId, question });
  return response.data;
};

export const indexDocumentForRag = async (documentId) => {
  const response = await API.post(`/ai/rag/index/${documentId}`);
  return response.data;
};

export const deleteDocumentRagIndex = async (documentId) => {
  const response = await API.delete(`/ai/rag/index/${documentId}`);
  return response.data;
};
