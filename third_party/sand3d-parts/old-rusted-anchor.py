# "Old rusted anchor" by trivial.cat, https://sketchfab.com/3d-models/abb9321ad29243228b4ea6dabc325db9, CC BY 4.0.
# Rewritten as a sand3d program by Sandflow, dataset sand3d-objaverse, id objaverse-abb9321ad29243228b4ea6dabc325db9, CC BY 4.0.
# Baked into js/anchor-iron.js by scripts/bake-anchor.mjs.
import sand3d as s3d


def anchor():
    main = s3d.at(shank(), x=-35, y=0, z=-717)
    return s3d.assembly('anchor', main)


def shank(w=140, length=1120, root_z=84, rise=510, tip_w=60, thick=95, tip_t=38):
    shaft = s3d.body('shaft', plan=[(-700,w),(250,70),(320,100),(380,78),(455,tip_w)], top=[(-700,root_z+thick/2),(455,root_z+rise+tip_t/2+16)], bottom=[(-700,root_z-thick/2),(455,root_z+rise-tip_t/2+16)], n=3.4)
    loop = s3d.tube('eye', d=97, d_in=49, h=30)
    loop = s3d.at(loop, x=5, y=492, z=620, rx=25)
    s3d.material(shaft, 'steel', color='#5d5148', roughness=0.85)
    s3d.material(loop, 'steel', color='#5d5148', roughness=0.85)
    arms = s3d.at(crown_arms(), x=-4,y=-650,z=-2)
    stock = s3d.at(crossbar(), x=5,y=310,z=-2.5)
    return s3d.group('shank',shaft,loop,arms,stock)


def crown_arms(w=1135, d=326, h=280, root=300, blade=142, t=16):
    arm = s3d.loft('curved_crown', s3d.station(z=-w/2,w=t/2,d=t/2,x=-170,y=120),s3d.station(z=-root,w=85,d=90,x=-85,y=-t,n=3),s3d.station(z=0,w=105,d=110,x=-55,y=-100,n=3),s3d.station(z=root,w=85,d=90,x=-85,y=-t,n=3),s3d.station(z=w/2,w=t/2,d=t/2,x=-t*10,y=140))
    arm = s3d.at(arm, ry=90)
    a=(root,-30,69)
    c=(w/2,140,159)
    upper=triangle_plate('upper_fluke',a,(root+100,29,69+blade),c,t)
    lower=triangle_plate('lower_fluke',a,(root+100,119,t*2),c,t)
    upper_copy=s3d.transform(s3d.copy(upper),mirror='x',z=35)
    lower_copy=s3d.transform(s3d.copy(lower),mirror='x',z=35)
    s3d.material(arm,'steel',color='#4e4239',roughness=0.85)
    for plate in [upper,lower,upper_copy,lower_copy]:
        s3d.material(plate,'steel',color='#4e4239',roughness=0.85)
    return s3d.group('crown_arms',arm,upper,lower,upper_copy,lower_copy)

def triangle_plate(name,a,b,c,t):
    u=tuple(b[i]-a[i] for i in range(3))
    v=tuple(c[i]-a[i] for i in range(3))
    length=sum(q*q for q in u)**0.5
    ex=tuple(q/length for q in u)
    normal=(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])
    nl=sum(q*q for q in normal)**0.5
    normal=tuple(q/nl for q in normal)
    ey=(normal[1]*ex[2]-normal[2]*ex[1],normal[2]*ex[0]-normal[0]*ex[2],normal[0]*ex[1]-normal[1]*ex[0])
    vx=sum(v[i]*ex[i] for i in range(3))
    vy=sum(v[i]*ey[i] for i in range(3))
    frame=s3d.Frame(origin=a,normal=normal,up=ey)
    return s3d.extrude(name,s3d.poly([(0,0),(length,0),(vx,vy)]),h=t,both=True,on=frame)


def crossbar(d=42, h=1133):
    rod = s3d.wire('stock',path=[(16,-221,1095),(0,-171,977),(-20,210,135),(-21,215,98),(-22,198,66),(-22,156,35)],d=d,fillet=35)
    end = s3d.at(s3d.sphere('knob',d=66),x=-22,y=145,z=2)
    top = s3d.at(s3d.sphere('knob',d=65),x=16,y=-224,z=1067)
    s3d.material(rod,'steel',color='#5d5148',roughness=0.85)
    s3d.material(end,'steel',color='#5d5148',roughness=0.85)
    s3d.material(top,'steel',color='#5d5148',roughness=0.85)
    return s3d.group('crossbar',rod,end,top)
