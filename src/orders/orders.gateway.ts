import { JwtService } from '@nestjs/jwt';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Role } from '../common/roles'; import { corsOptions } from '../common/cors'; import { AuthService } from '../auth/auth.service';
@WebSocketGateway({ cors: corsOptions() })
export class OrdersGateway implements OnGatewayConnection {
  constructor(private readonly jwt:JwtService,private readonly auth:AuthService){} @WebSocketServer() server!:Server;
  async handleConnection(client:Socket){const token=client.handshake.auth.token??client.handshake.headers.authorization?.replace(/^Bearer\s+/i,'');try{const claim=await this.jwt.verifyAsync<{sub:string;role:Role;restaurantId?:string}>(token);const user=await this.auth.profile(claim.sub);if(user.role!==claim.role||user.restaurantId!==claim.restaurantId)throw new Error('Stale identity');await client.join(`user:${user.id}`);if((user.role===Role.RESTAURANT_ADMIN||user.role===Role.EMPLOYEE)&&user.restaurantId)await client.join(`restaurant:${user.restaurantId}`);}catch{client.disconnect(true)}}
  publishNewOrder(restaurantId:string,order:unknown){this.server.to(`restaurant:${restaurantId}`).emit('order.created',order)}
  publishOrderUpdated(restaurantId:string,customerId:string|undefined,order:unknown){this.server.to(`restaurant:${restaurantId}`).emit('order.updated',order);if(customerId)this.server.to(`user:${customerId}`).emit('order.updated',order)}
}
