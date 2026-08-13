import { MothMark, OrbitingMoth } from '../../packages/extension/components/moth/panel';

export function Preview() {
  return (
    <div className="flex items-center gap-8">
      <OrbitingMoth size={176} />
      <OrbitingMoth size={96} />
      <MothMark size={48} />
      <MothMark size={20} beat={false} />
    </div>
  );
}
