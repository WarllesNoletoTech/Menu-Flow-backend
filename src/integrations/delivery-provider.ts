import { Order } from '../common/schemas';

/** Boundary for third-party dispatch services, including a future Rappidex adapter. */
export interface DeliveryProvider {
  dispatch(order: Order): Promise<{ externalId: string }>;
}
