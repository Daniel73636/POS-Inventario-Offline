import { Body, Controller, Get, HttpCode, Inject, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { LoginRequestSchema } from '@pos/contracts';
import { verifyPassword, type Database } from '@pos/db';
import { CONFIG, DB, type AppConfig } from '../config';
import { parseBody, type AuthedRequest } from '../common/http';
import { RateLimitGuard } from '../common/rate-limit';
import { OwnerGuard } from './guards';
import { signToken } from './token';

@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async login(@Body() body: unknown) {
    const { email, password } = parseBody(LoginRequestSchema, body);
    const [owner] = await this.db.query<{ id: string; tenant_id: string; email: string; name: string; password_hash: string }>(
      'SELECT o.id, o.tenant_id, o.email, o.name, o.password_hash FROM owners o WHERE lower(o.email) = lower($1)',
      [email],
    );
    if (!owner || !verifyPassword(password, owner.password_hash)) throw new UnauthorizedException('Correo o contraseña incorrectos');
    const [tenant] = await this.db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [owner.tenant_id]);
    return {
      token: signToken({ ownerId: owner.id, tenantId: owner.tenant_id, email: owner.email }, this.config.jwtSecret),
      owner: { id: owner.id, name: owner.name, email: owner.email },
      tenant: { id: owner.tenant_id, name: tenant?.name ?? '' },
    };
  }

  @Get('me')
  @UseGuards(OwnerGuard)
  async me(@Req() req: AuthedRequest) {
    const [tenant] = await this.db.query<{ id: string; name: string }>('SELECT id, name FROM tenants WHERE id = $1', [req.owner!.tenantId]);
    return { owner: req.owner, tenant };
  }
}
