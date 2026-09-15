package chihalu.stackplus.mixin;

import chihalu.stackplus.codec.StackPlusCodecs;
import com.mojang.serialization.Codec;
import java.util.EnumMap;
import java.util.Map;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Mutable;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 防具・オフハンドの保存に使われるEntityEquipmentのCODECをStackPlus対応へ差し替えます。
 * vanillaのCODECはItemStack.CODEC（99個上限）を使っているため、
 * オフハンドに100個以上を持ったまま保存すると"equipment"タグ全体の書き込みが失敗し、
 * 次回読み込み時に防具とオフハンドがまとめて消えていました。
 */
@Mixin(EntityEquipment.class)
public class EntityEquipmentMixin {

    @Shadow
    @Final
    @Mutable
    public static Codec<EntityEquipment> CODEC;

    @Inject(method = "<clinit>", at = @At("RETURN"))
    private static void stackplus$replaceCodec(CallbackInfo ci) {
        CODEC = Codec.unboundedMap(EquipmentSlot.CODEC, StackPlusCodecs.ITEM_STACK_CODEC).xmap(items -> {
            EntityEquipment equipment = new EntityEquipment();
            items.forEach(equipment::set);
            return equipment;
        }, equipment -> {
            Map<EquipmentSlot, ItemStack> items = new EnumMap<>(EquipmentSlot.class);
            for (EquipmentSlot slot : EquipmentSlot.values()) {
                ItemStack stack = equipment.get(slot);
                if (!stack.isEmpty()) {
                    items.put(slot, stack);
                }
            }
            return items;
        });
    }
}
