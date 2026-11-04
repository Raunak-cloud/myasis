import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminUserDashboard } from '../src/components/AdminUserDashboard';
import '../src/index.css';
function Fixture(){
  const [id,setId]=useState('11');
  return <><button onClick={()=>setId(id==='11'?'22':'11')}>Switch account</button><AdminUserDashboard key={id} userId={id} email={`user${id}@example.test`} onChanged={()=>{document.documentElement.dataset.changed='yes';}}/></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
