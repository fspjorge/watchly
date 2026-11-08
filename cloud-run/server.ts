import { createWatchlyServer } from './http.ts';

const port=Number(process.env.PORT??'8080');
if(!Number.isInteger(port)||port<1||port>65535){process.stderr.write('PORT must be an integer from 1 to 65535.\n');process.exit(1);}
if(!process.env.WATCHLY_HMAC_SECRET){process.stderr.write('WATCHLY_HMAC_SECRET is required.\n');process.exit(1);}
const server=createWatchlyServer({secret:process.env.WATCHLY_HMAC_SECRET});
server.listen(port,'0.0.0.0',()=>process.stdout.write(`Watchly check service listening on ${port}\n`));
