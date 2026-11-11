import express from 'express';
import type { Request, Response } from 'express';
import * as reportsController from '../controllers/reports.controller';
import { httpError, sendError } from '../lib/http';
import * as practice from '../services/practice-reports.service';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

router.get('/dashboard', requirePermission('reports.read'), reportsController.dashboard);
router.get('/', requirePermission('reports.read'), reportsController.index);
router.post('/', requirePermission('reports.read'), reportsController.generate);

// Practice reports: WIP, debtors, utilisation, realisation, fee earners.
// ?from=YYYY-MM-DD&to=YYYY-MM-DD; .csv for a spreadsheet download.
const builders = {
  wip: practice.wip,
  debtors: practice.debtors,
  utilisation: practice.utilisation,
  realisation: practice.realisation,
  'fee-earners': practice.feeEarners,
} as const;
type Kind = keyof typeof builders;

router.get(
  '/practice/:report',
  requirePermission('reports.read'),
  async (req: Request, res: Response) => {
    try {
      const match = /^([a-z-]+?)(\.csv)?$/.exec(String(req.params.report));
      const kind = match?.[1] as Kind | undefined;
      if (!kind || !(kind in builders)) throw httpError('Report not found', 404);
      const query = { from: req.query.from, to: req.query.to };
      res.setHeader('cache-control', 'no-store');
      if (match?.[2]) {
        const body = await practice.reportCsv(kind, query, req.auth ?? {});
        const { from, to } = practice.period(query);
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="${kind}-${from}-to-${to}.csv"`);
        res.status(200).send(body);
        return;
      }
      res.status(200).json(await builders[kind](query, req.auth ?? {}));
    } catch (error) {
      sendError(res, error);
    }
  },
);

export default router;
