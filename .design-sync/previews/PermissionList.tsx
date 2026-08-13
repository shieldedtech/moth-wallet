import { PermissionList } from '@shieldedtech/moth-extension';

export const ConnectPermissions = () => (
  <PermissionList
    can={['See your addresses', 'Ask you to approve transactions']}
    cant={["Move money without your OK", 'See your shielded balances or history']}
  />
);
