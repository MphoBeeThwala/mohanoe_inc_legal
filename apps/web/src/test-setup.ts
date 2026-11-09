import '@testing-library/jest-dom/vitest';
import axios from 'axios';

// Tests never reach a real API: every request fails fast like an offline
// network, so components exercise their error paths without jsdom noise.
axios.defaults.adapter = async (config) => {
  throw new axios.AxiosError('Network disabled in tests', 'ERR_NETWORK', config);
};
