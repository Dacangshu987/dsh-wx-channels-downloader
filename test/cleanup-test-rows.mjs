// Cleanup injected test rows from the real catalog (keeps the user's store pristine).
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('C:/Users/31559/.dsh/wx-channels/records.db')
const r = db.prepare("DELETE FROM video_catalog WHERE object_id IN ('proxy-test-1','proxy-test-2','oid-1')").run()
console.log('cleaned rows:', r.changes)
db.close()