// Set defaults for a new instance only; retain administrator choices on reruns.
import {migrate,sql} from '../src/db';
await migrate();
for(const [key,value] of [['instance_name','Xine'],['signup_mode','open'],['source_url','https://github.com/loxywastaken/x']]){
 await sql`insert into settings(key,value) values(${key},${JSON.stringify(value)}::text::jsonb) on conflict(key) do nothing`;
}
await sql.close();
console.log('Xine instance defaults configured; existing settings preserved.');
