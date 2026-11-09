import { useEffect, useState } from 'react';
import type { SubscriptionBanner as Banner } from '@ahava88/shared';
import { api } from '../api';

const day = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString('en-ZA', {
        timeZone: 'Africa/Johannesburg',
        day: 'numeric',
        month: 'long',
      })
    : '';

/** Trial days left, overdue payment, or read-only mode, for everyone in the firm. */
function SubscriptionBanner({ canManage }: { canManage: boolean }) {
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    api
      .get<Banner>('/subscription/banner')
      .then(({ data }) => setBanner(data))
      .catch(() => setBanner(null));
  }, []);

  if (!banner) {
    return null;
  }
  const action = canManage
    ? ' Go to Account → Subscription.'
    : ' Please let an administrator know.';
  let tone = 'info';
  let message = '';
  if (banner.readOnly) {
    tone = 'error';
    message = `This workspace is read-only because the subscription is unpaid. You can still read and export records.${action}`;
  } else if (banner.effectiveStatus === 'past_due') {
    tone = 'warn';
    message = `The subscription payment is overdue. The workspace becomes read-only on ${day(banner.suspendsAt)}.${action}`;
  } else if (banner.effectiveStatus === 'trialing' && (banner.daysLeft ?? 99) <= 14) {
    message = `The trial ends on ${day(banner.paidThrough)}.${canManage ? ' Choose a plan under Account → Subscription.' : ''}`;
  } else if (banner.effectiveStatus === 'cancelled' && canManage) {
    message = `The subscription is cancelled; access continues until ${day(banner.paidThrough)}.`;
  }
  if (!message) {
    return null;
  }
  return (
    <p className={`notice notice-${tone} subscription-banner`} role="status">
      {message}
    </p>
  );
}

export default SubscriptionBanner;
