import { Tabs, TabsList, TabsTrigger } from '@shieldedtech/moth-extension';

export const AddressSwitch = () => (
  <Tabs defaultValue="shielded">
    <TabsList>
      <TabsTrigger value="shielded">Shielded</TabsTrigger>
      <TabsTrigger value="unshielded">Unshielded</TabsTrigger>
    </TabsList>
  </Tabs>
);

export const SecondSelected = () => (
  <Tabs defaultValue="unshielded">
    <TabsList>
      <TabsTrigger value="shielded">Shielded</TabsTrigger>
      <TabsTrigger value="unshielded">Unshielded</TabsTrigger>
    </TabsList>
  </Tabs>
);
