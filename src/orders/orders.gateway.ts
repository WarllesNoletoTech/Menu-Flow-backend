import { JwtService } from '@nestjs/jwt';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Role } from '../common/roles';
import { corsOptions } from '../common/cors';
import { AuthService } from '../auth/auth.service';

/** Restaurant rooms prevent order events leaking across tenants. */
@WebSocketGateway({ cors: corsOptions() })
export class OrdersGateway implements OnGatewayConnection {
  constructor(private readonly jwt: JwtService, private readonly auth: AuthService) {}
  @WebSocketServer() server!: Server;

  async handleConnection(client: Socket) {
    const token = client.handshake.auth.token ?? client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
    const restaurantId = typeof client.handshake.query.restaurantId === 'string' ? client.handshake.query.restaurantId : undefined;
    try {
      const tokenUser = await this.jwt.verifyAsync<{ sub: string; role: Role; restaurantId?: string }>(token);
      const currentUser = await this.auth.profile(tokenUser.sub);
      if (currentUser.role !== tokenUser.role || currentUser.restaurantId !== tokenUser.restaurantId) throw new Error('Stale identity');
      if (!restaurantId || (currentUser.role !== Role.SUPER_ADMIN && currentUser.restaurantId !== restaurantId)) throw new Error('Tenant access denied');
      await client.join(`restaurant:${restaurantId}`);
    } catch {
      client.disconnect(true);
    }
  }

  publishNewOrder(restaurantId: string, order: unknown) {
    this.server.to(`restaurant:${restaurantId}`).emit('order.created', order);
  }

  publishOrderUpdated(restaurantId: string, order: unknown) {
    this.server.to(`restaurant:${restaurantId}`).emit('order.updated', order);
  }
}
