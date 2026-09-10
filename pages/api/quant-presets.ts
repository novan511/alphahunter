import type { NextApiRequest, NextApiResponse } from 'next';
import { listPresets } from '../../lib/quant/catalog';

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ presets: ReturnType<typeof listPresets> } | { error: string }>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  return res.status(200).json({ presets: listPresets() });
}
