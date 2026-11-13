"use strict";
(() => {
  const button=document.getElementById("checkLiteUpdate");
  const status=document.getElementById("liteUpdateState");
  if(!button||!status)return;
  const api=window.nhdUpdater;
  if(!api){button.disabled=true;status.textContent="Mở NHD từ ứng dụng Desktop để cập nhật an toàn.";return;}
  const show=s=>{status.textContent=s;};
  async function refresh(){
    try{
      const s=await api.status();
      show("Phiên bản "+s.installedVersion+" · "+(s.available?"Sẵn sàng kiểm tra GitHub":"Chỉ hoạt động trong bản cài Windows")+
        (s.phase&&s.phase!=="idle"?" · Trạng thái: "+s.phase:"")+
        (s.recoveryDetail?" · "+s.recoveryDetail:""));
    }catch(e){show("Không đọc được trạng thái cập nhật: "+e.message);}
  }
  button.addEventListener("click",async()=>{
    button.disabled=true;
    try{await api.checkAndInstall();await refresh();}
    catch(e){show("Kiểm tra cập nhật thất bại: "+e.message);}
    finally{button.disabled=false;}
  });
  void refresh();
})();
