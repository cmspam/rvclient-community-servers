// The servers and UDP ports this box will use, for the installer: the kit's ds-instances.json in
// the data folder (when the server is set up) with RV_COUNTS / RV_PORT_BASE / RV_PORTS /
// RV_SPARE_OFFSET / RV_SPARE_PORTS applied, by the same rules the container uses when it starts.
// Nothing is written. One line per server:
//   server <id> <mode> <port> <spare port, or - for Playground>
// A bad choice prints the reason and exits with 2, before anything is installed.
import { INSTANCES, readJson, parsePortOverride, resolvePorts, serverPorts } from './lib.mjs';

try {
    const instances = readJson(INSTANCES, null);
    const choice = parsePortOverride(process.env);
    const servers = choice ? resolvePorts(choice, instances).servers : serverPorts(instances);
    for (const x of servers) console.log(`server ${x.id} ${x.key} ${x.port} ${x.sparePort ?? '-'}`);
} catch (e) {
    console.error(e.message);
    process.exit(2);
}
