export async function marketingApi<T>(path:string,method='GET',body?:unknown):Promise<T> {
  const response=await fetch(`/api/marketing/${path}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok) throw new Error(value.error || 'Request failed.');return value;
}
