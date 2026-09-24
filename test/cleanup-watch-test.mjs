// Clean offline-smoke test rows from the real store.
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('C:/Users/31559/.dsh/wx-channels/records.db')
const c1 = db.prepare("DELETE FROM video_catalog WHERE object_id IN ('a1','o1')").run()
const c2 = db.prepare("DELETE FROM watched WHERE username IN ('v2_watched@finder','乙方')").run()
db.close()
console.log('cleaned catalog:', c1.changes, 'watched:', c2.changes)