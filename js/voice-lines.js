export const SPOKEN_ORDERS=['full','reduced','furl','weather','watch','transfer','drop-anchor','weigh-anchor'];

// One exchange at a time. Repeated clicks collapse into the newest pending
// order; they cannot build an unbounded queue of obsolete captain commands.
export function createVoiceDirector({play,assets,crew,available=()=>true}){
  let clock=0,busyUntil=0,pending=null,ack=null,cursor=0,lastId='',lastAt=-10;
  const hands=crew.filter(person=>person.id!=='ines');
  function start(request){
    const captain='captain-'+request.id;
    if(!available()||!assets[captain])return false;
    const hand=crew.find(person=>person.id===request.crewId)??hands[cursor++%Math.max(1,hands.length)];
    const seconds=play(captain,.7,request.boat??{x:0,z:0},1);
    if(!(seconds>0))return false;
    const reply=hand&&'crew-'+hand.id;
    ack=reply&&assets[reply]?{id:reply,at:clock+seconds+.18,boat:request.boat}:null;
    busyUntil=clock+seconds+.18+(ack?assets[reply].seconds:0)+.3;
    return true;
  }
  return {
    order(id,options={}){
      if(!SPOKEN_ORDERS.includes(id)||!available())return false;
      if(id===lastId&&clock-lastAt<1)return false;
      lastId=id;lastAt=clock;
      const request={id,...options};
      if(clock<busyUntil){pending=request;return true;}
      return start(request);
    },
    update(dt){
      clock+=Math.max(0,Number.isFinite(dt)?dt:0);
      if(!available()){pending=null;ack=null;busyUntil=clock;return;}
      if(ack&&clock>=ack.at){const reply=ack;ack=null;play(reply.id,.6,reply.boat??{x:0,z:0},1);}
      if(pending&&clock>=busyUntil){const next=pending;pending=null;start(next);}
    },
    clear(){pending=null;ack=null;busyUntil=clock;lastId='';lastAt=-10;},
    get busy(){return clock<busyUntil;},
  };
}
