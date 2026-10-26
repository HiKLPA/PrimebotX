"""Local SDK message transport test. Domain 177, localhost only; never controls Q1."""
import os
os.environ['ROS_DOMAIN_ID']='177'
os.environ['ROS_LOCALHOST_ONLY']='1'
import time
import rclpy
from aimdk_msgs.msg import Bms

rclpy.init()
node=rclpy.create_node('primebot_sdk_local_check')
received=[]
sub=node.create_subscription(Bms,'/primebot/local_check/bms',lambda msg:received.append(msg.remaining_capacity_percentage),10)
pub=node.create_publisher(Bms,'/primebot/local_check/bms',10)
deadline=time.monotonic()+10
while time.monotonic()<deadline and not received:
    message=Bms();message.remaining_capacity_percentage=42
    pub.publish(message)
    rclpy.spin_once(node,timeout_sec=.1)
node.destroy_node()
rclpy.shutdown()
assert received and received[-1]==42, 'Local SDK transport failed'
print('PASS: localhost-only DDS Bms publish/subscribe, synthetic battery=42; NOT a robot test')
