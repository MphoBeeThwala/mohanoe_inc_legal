import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as calendarService from '../services/calendar.service';

async function index(req: Request, res: Response) {
  try {
    const events = await calendarService.listEvents();
    res.status(200).json(events);
  } catch (error) {
    sendError(res, error);
  }
}

async function upcoming(req: Request, res: Response) {
  try {
    const events = await calendarService.getUpcomingEvents();
    res.status(200).json(events);
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req: Request, res: Response) {
  try {
    const event = await calendarService.createEvent(req.body, req.auth);
    res.status(201).json(event);
  } catch (error) {
    sendError(res, error);
  }
}

export {
  create,
  index,
  upcoming,
};
